package cli

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"

	"golang.org/x/term"

	"github.com/mupt-ai/dari-cli/internal/api"
)

// agentKeyGateways are the gateways one key can serve most models through,
// in the order the onboarding menu offers them.
var agentKeyGateways = []struct{ provider, name string }{
	{"vercel-ai-gateway", "Vercel AI Gateway"},
	{"openrouter", "OpenRouter"},
}

// agentProviderKeys moves selected models onto the user's saved provider
// credentials. Models it does not name stay on Dari credits.
type agentProviderKeys struct {
	// modelProviders maps a model to the provider that serves it on a user key.
	modelProviders map[string]string
	// credentialIDs maps a provider to the saved credential it uses.
	credentialIDs map[string]string
	// apiFallbackModels are subscription models that keep running on the
	// user's key while the subscription is unavailable.
	apiFallbackModels []string
}

// fallbackModels adds the models that fall back to the user's key to the
// router's current API fallback models, keeping only enabled ones. Nil leaves
// the router's API fallback as it is.
func (keys agentProviderKeys) fallbackModels(current, enabled []string) []string {
	if len(keys.apiFallbackModels) == 0 {
		return nil
	}
	models := []string{}
	for _, id := range append(slices.Clone(current), keys.apiFallbackModels...) {
		if slices.Contains(enabled, id) && !slices.Contains(models, id) {
			models = append(models, id)
		}
	}
	return models
}

// apply routes the router's models onto the user's keys and drops key
// sources for providers that no longer serve any of its models.
func (keys agentProviderKeys) apply(providers, sources map[string]string) {
	maps.Copy(providers, keys.modelProviders)
	served := slices.Collect(maps.Values(providers))
	maps.DeleteFunc(sources, func(provider, _ string) bool { return !slices.Contains(served, provider) })
	for provider := range keys.credentialIDs {
		sources[provider] = "user"
	}
}

type agentProviderCredential struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Label           string `json:"label"`
	Provider        string `json:"provider"`
	AuthScheme      string `json:"auth_scheme"`
	CredentialScope string `json:"credential_scope"`
}

// chooseAgentProviderKeys asks once whether the selected models run on the
// user's own keys. ids are the selected models and providers the provider
// serving each; providers in subscribed keep serving their models with the
// user's personal subscription. Without a terminal it asks nothing, so
// scripts keep Dari credits.
// keep is the first, default option: Dari credits in new setups, current
// credentials for a router set up earlier.
func chooseAgentProviderKeys(
	ctx context.Context,
	client *api.Client,
	stdin io.Reader,
	stderr io.Writer,
	models []agentModel,
	ids []string,
	providers map[string]string,
	subscribed []string,
	keep agentChoiceOption,
) (agentProviderKeys, error) {
	if !agentInputIsTerminal(stdin) {
		return agentProviderKeys{}, nil
	}
	choice, err := runAgentChoiceTUI(stdin, stderr, "Use your own provider keys?", nil, []agentChoiceOption{
		keep,
		{label: "Vercel AI Gateway key (serves most models)"},
		{label: "OpenRouter key (serves most models)"},
		{label: "Direct provider keys (Anthropic, OpenAI, …)"},
	})
	if err != nil {
		return agentProviderKeys{}, err
	}
	keys, err := configureAgentProviderKeys(ctx, client, stdin, stderr, choice, models, ids, providers, subscribed)
	if err != nil {
		return agentProviderKeys{}, err
	}
	where := "on the Credentials page of the Dari web app"
	if page := agentWebAppURL(ctx, client, "/credentials"); page != "" {
		where = "at " + page
	}
	fmt.Fprintln(stderr, "Add AWS Bedrock, Microsoft Azure, or other credentials "+where)
	return keys, nil
}

// connectAgentProviderKeysOnRequest offers provider keys for the models the
// router already serves. Onboarding only asks while it picks models, which
// a default router a new organization starts with never needs, so --connect
// asks for routers set up earlier.
func connectAgentProviderKeysOnRequest(ctx context.Context, client *api.Client, routerID string, stdin io.Reader, stderr io.Writer) error {
	routers, err := listAgentRouters(ctx, client)
	if err != nil {
		return err
	}
	router, ok := findAgentRouter(routers, func(router agentRouter) bool { return router.ID == routerID })
	if !ok {
		return fmt.Errorf("router %s was not found", routerID)
	}
	models, err := listAgentModels(ctx, client)
	if err != nil {
		return err
	}
	models = includeCurrentAgentModels(models, router)
	body := agentRouterUpdateBody(router, models, currentAgentModelChoices(router))
	keys, err := chooseAgentProviderKeys(ctx, client, stdin, stderr, models, body.EnabledModels, body.ModelProviders, router.SubscriptionProviders, agentChoiceOption{label: "No, keep current credentials (default)", done: "Keeping current credentials"})
	if err != nil || len(keys.credentialIDs) == 0 {
		return err
	}
	_, err = attachAgentProviderKeys(ctx, client, router, models, keys)
	return err
}

// attachAgentProviderKeys moves the router's own models onto the chosen keys,
// leaving its model set and thinking levels as they are.
func attachAgentProviderKeys(ctx context.Context, client *api.Client, router agentRouter, models []agentModel, keys agentProviderKeys) (agentRouter, error) {
	body := agentRouterUpdateBody(router, models, currentAgentModelChoices(router))
	maps.DeleteFunc(keys.modelProviders, func(model, _ string) bool { return !slices.Contains(body.EnabledModels, model) })
	keys.apply(body.ModelProviders, body.ProviderKeySources)
	served := slices.Collect(maps.Values(body.ModelProviders))
	maps.DeleteFunc(keys.credentialIDs, func(provider, _ string) bool { return !slices.Contains(served, provider) })
	maps.DeleteFunc(body.ProviderKeySources, func(provider, _ string) bool { return !slices.Contains(served, provider) })
	body.ProviderCredentialIDs = keys.credentialIDs
	body.SubscriptionAPIFallbackModels = keys.fallbackModels(router.SubscriptionAPIFallbackModels, body.EnabledModels)
	return putAgentRouter(ctx, client, router.ID, body)
}

func currentAgentModelChoices(router agentRouter) []agentModelChoice {
	choices := make([]agentModelChoice, len(router.EnabledModels))
	for i, id := range router.EnabledModels {
		choices[i] = agentModelChoice{ID: id, Levels: router.ModelThinkingLevels[id]}
	}
	return choices
}

// putAgentRouter updates a router and returns it as saved.
func putAgentRouter(ctx context.Context, client *api.Client, routerID string, body agentRouterUpdateRequest) (agentRouter, error) {
	// Decode into a fresh router: JSON decoding merges into existing maps,
	// so a model the update removed would keep its old provider entry.
	var updated agentRouter
	path := "/v1/organizations/current/routers/" + url.PathEscape(routerID)
	if err := client.Do(ctx, http.MethodPut, path, body, &updated); err != nil {
		return agentRouter{}, api.HumanError(err)
	}
	return updated, nil
}

// configureAgentProviderKeys carries out a choice from the provider keys
// menu: 0 keeps Dari credits, 1 and 2 use a gateway key, 3 direct keys.
func configureAgentProviderKeys(
	ctx context.Context,
	client *api.Client,
	stdin io.Reader,
	stderr io.Writer,
	choice int,
	models []agentModel,
	ids []string,
	providers map[string]string,
	subscribed []string,
) (agentProviderKeys, error) {
	keys := agentProviderKeys{modelProviders: map[string]string{}, credentialIDs: map[string]string{}}
	if choice == 0 {
		return keys, nil
	}
	catalog, err := fetchAgentModelCatalog(ctx, client)
	if err != nil {
		return keys, err
	}
	var listed struct {
		Credentials []agentProviderCredential `json:"credentials"`
	}
	if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials", nil, &listed); err != nil {
		return keys, api.HumanError(err)
	}
	names := map[string]string{}
	for _, model := range models {
		names[model.ID] = model.DisplayName
	}
	labels := map[string]string{}
	served := map[string][]string{}
	for _, group := range catalog.Groups {
		labels[group.Provider] = group.ProviderLabel
		for _, model := range group.Models {
			served[group.Provider] = append(served[group.Provider], model.ID)
		}
	}
	label := func(provider string) string {
		if labels[provider] != "" {
			return labels[provider]
		}
		return provider
	}
	listModels := func(modelIDs []string) string {
		display := make([]string, len(modelIDs))
		for i, id := range modelIDs {
			display[i] = cmp.Or(names[id], id)
		}
		return strings.Join(display, ", ")
	}

	if choice <= len(agentKeyGateways) {
		gateway := agentKeyGateways[choice-1]
		var moved, kept, unserved []string
		for _, id := range ids {
			switch {
			case slices.Contains(subscribed, providers[id]):
				kept = append(kept, id)
			case slices.Contains(served[gateway.provider], id):
				moved = append(moved, id)
			default:
				unserved = append(unserved, id)
			}
		}
		if len(kept) > 0 {
			fmt.Fprintf(stderr, "Staying on your personal subscription: %s\n", listModels(kept))
		}
		if len(unserved) > 0 {
			fmt.Fprintf(stderr, "%s does not serve these, so they stay on Dari credits: %s\n", gateway.name, listModels(unserved))
		}
		if len(moved) == 0 {
			return keys, nil
		}
		credentialID, err := agentProviderCredentialID(ctx, client, stdin, stderr, gateway.provider, gateway.name, listed.Credentials)
		if err != nil {
			return keys, err
		}
		for _, id := range moved {
			keys.modelProviders[id] = gateway.provider
		}
		keys.credentialIDs[gateway.provider] = credentialID
		agentStep(stderr, "Using your "+gateway.name+" key for "+listModels(moved))
		return keys, nil
	}

	var direct []string
	for _, id := range ids {
		if !slices.Contains(direct, providers[id]) {
			direct = append(direct, providers[id])
		}
	}
	for _, provider := range direct {
		use, err := confirmDefaultNo(stdin, stderr, "Use your own "+label(provider)+" key? [y/N] ")
		if err != nil {
			return keys, err
		}
		if !use {
			continue
		}
		credentialID, err := agentProviderCredentialID(ctx, client, stdin, stderr, provider, label(provider), listed.Credentials)
		if err != nil {
			return keys, err
		}
		keys.credentialIDs[provider] = credentialID
		if !slices.Contains(subscribed, provider) {
			agentStep(stderr, "Using your "+label(provider)+" key")
			continue
		}
		// The subscription keeps serving these models; the key takes over
		// only while it is unavailable.
		for _, id := range ids {
			if providers[id] == provider {
				keys.apiFallbackModels = append(keys.apiFallbackModels, id)
			}
		}
		agentStep(stderr, "Using your "+label(provider)+" key when your subscription is unavailable")
	}
	return keys, nil
}

// agentProviderCredentialID offers the organization's saved API key for the
// provider, or saves a new one, and returns its credential ID.
func agentProviderCredentialID(
	ctx context.Context,
	client *api.Client,
	stdin io.Reader,
	stderr io.Writer,
	provider string,
	name string,
	saved []agentProviderCredential,
) (string, error) {
	for _, credential := range saved {
		if credential.Provider != provider || credential.CredentialScope != "organization" || credential.AuthScheme != "api_key" {
			continue
		}
		use, answered, err := confirmDefaultYes(stdin, stderr,
			fmt.Sprintf("Use your saved %s key %q? [Y/n] ", name, cmp.Or(credential.Label, credential.Name)))
		if err != nil {
			return "", err
		}
		if use || !answered {
			return credential.ID, nil
		}
		break
	}
	fmt.Fprintf(stderr, "Paste your %s API key: ", name)
	key, err := readAgentSecret(stdin)
	fmt.Fprintln(stderr)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("read %s API key: %w", name, err)
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return "", fmt.Errorf("no %s API key was entered", name)
	}
	var created agentProviderCredential
	if err := client.Do(ctx, http.MethodPost, "/v1/organizations/current/credentials/provider-credentials", map[string]any{
		"provider": provider,
		"label":    name,
		"auth":     map[string]string{"type": "api_key", "api_key": key},
	}, &created); err != nil {
		return "", api.HumanError(err)
	}
	if created.ID == "" {
		return "", fmt.Errorf("Dari did not return the saved %s credential", name)
	}
	agentStep(stderr, "Saved your "+name+" key")
	return created.ID, nil
}

// readAgentSecret reads one line without echoing it on a terminal.
func readAgentSecret(stdin io.Reader) (string, error) {
	if file, ok := stdin.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		raw, err := term.ReadPassword(int(file.Fd()))
		return string(raw), err
	}
	return readAgentLine(stdin)
}

func confirmDefaultNo(stdin io.Reader, stderr io.Writer, prompt string) (bool, error) {
	fmt.Fprint(stderr, prompt)
	answer, err := readAgentLine(stdin)
	if errors.Is(err, io.EOF) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "", "n", "no":
		return false, nil
	case "y", "yes":
		return true, nil
	default:
		return false, fmt.Errorf("expected yes or no, got %q", strings.TrimSpace(answer))
	}
}

// agentKeepDariCredits is the default answer while setting up a new router.
var agentKeepDariCredits = agentChoiceOption{label: "No, use Dari credits (default)", done: "Using Dari credits"}
