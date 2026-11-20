package cli

import (
	"cmp"
	"context"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/mupt-ai/dari/internal/api"
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
	// subscriptionProviders are the providers whose models run on the user's
	// subscription.
	subscriptionProviders []string
	// subscriptionModels are the models the subscription serves, set only
	// when other models of a subscription's provider are paid for another
	// way, so the choice is made per model.
	subscriptionModels []string
	// offSubscription are the models of a subscription's provider the picker
	// put on another payment source, set with subscriptionModels.
	offSubscription []string
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

// agentKeyCredentialsPageOnly need more than one key, so they are connected
// on the Subscriptions & Keys page of the web app instead of the Accounts page.
var agentKeyCredentialsPageOnly = []string{"azure", "amazon-bedrock"}

// agentAPIKeys are the organization's saved API keys, the first per provider.
func agentAPIKeys(credentials []agentProviderCredential) map[string]agentProviderCredential {
	keys := map[string]agentProviderCredential{}
	for _, credential := range credentials {
		if credential.CredentialScope != "organization" || credential.AuthScheme != "api_key" || credential.Provider == "" {
			continue
		}
		if _, ok := keys[credential.Provider]; !ok {
			keys[credential.Provider] = credential
		}
	}
	return keys
}

// connectAgentAPIKey asks which provider's API key to connect, then saves the
// pasted key. Providers already connected are not offered again. It reports
// whether a key was saved; Back saves none.
func connectAgentAPIKey(ctx context.Context, client *api.Client, stdin io.Reader, stderr io.Writer, connected map[string]agentProviderCredential) (bool, error) {
	catalog, err := fetchAgentModelCatalog(ctx, client)
	if err != nil {
		return false, err
	}
	type keyProvider struct{ provider, name string }
	offered := []keyProvider{}
	options := []agentChoiceOption{}
	// Gateways, where one key serves most models, then the providers' own keys.
	offer := func(provider, name, heading string) {
		if _, ok := connected[provider]; ok || slices.ContainsFunc(offered, func(p keyProvider) bool { return p.provider == provider }) {
			return
		}
		option := agentChoiceOption{label: name}
		if !slices.ContainsFunc(options, func(o agentChoiceOption) bool { return o.heading == heading }) {
			option.heading = heading
		}
		offered = append(offered, keyProvider{provider, name})
		options = append(options, option)
	}
	for _, gateway := range agentKeyGateways {
		offer(gateway.provider, gateway.name, "Gateways")
	}
	for _, group := range catalog.Groups {
		if group.Provider != "" && !slices.Contains(agentKeyCredentialsPageOnly, group.Provider) {
			offer(group.Provider, cmp.Or(group.ProviderLabel, group.Provider), "Providers")
		}
	}
	// Credentials that need more than one key are added in the web app.
	webApp := agentWebAppURL(ctx, client, "/credentials")
	options = append(options,
		agentChoiceOption{label: "AWS Bedrock, Microsoft Azure, or Other " + ansiGray + "(opens the Dari web app)" + ansiReset, heading: "More"},
		agentChoiceOption{label: "Back", gap: true},
	)
	// Esc on the key's input comes back to this list.
	for {
		choice, err := runAgentChoiceTUI(stdin, stderr, "", nil, options)
		if err != nil || choice == len(offered)+1 {
			return false, err
		}
		if choice == len(offered) {
			if webApp == "" || !openAgentBrowser(webApp) {
				where := "on the Subscriptions & Keys page of the Dari web app"
				if webApp != "" {
					where = "at " + webApp
				}
				agentPrintln(stderr, "Add other credentials "+where)
			}
			continue
		}
		saved, err := saveAgentAPIKey(ctx, client, stdin, stderr, offered[choice].provider, offered[choice].name)
		if saved || err != nil {
			return saved, err
		}
	}
}

// agentModelSource is where a model's requests are paid for: the user's
// personal subscription, a saved API key (the model's own provider or a
// gateway that serves it), or Dari credits.
type agentModelSource struct {
	// "subscription", "key", or "managed"; in a template's picker also
	// "connect" (a subscription not yet connected) or "add-key", which enter
	// runs rather than picks.
	kind          string
	provider      string // the provider that serves the model
	modelProvider string // the model's own provider
	credentialID  string // the saved key, for "key"
	label         string
}

// action reports whether choosing the source runs a setup step first.
func (source agentModelSource) action() bool {
	return source.kind == "connect" || source.kind == "add-key"
}

// native reports whether the model stays on its own provider, as opposed to
// moving to a gateway.
func (source agentModelSource) native() bool {
	return source.provider == source.modelProvider
}

// subscriptionOnlyProviders serve models only through a personal
// subscription: no API key or Dari credits pay for them.
var subscriptionOnlyProviders = map[string]bool{"opencode-go": true}

// agentKeyContext is what deciding sources needs: the organization's saved
// API keys and which providers serve which models.
type agentKeyContext struct {
	saved         map[string]agentProviderCredential
	served        map[string][]string
	labels        map[string]string
	subscriptions map[string]string // router provider -> plan name, for connected plans
	// blocked are the source kinds ("key", "managed") a template's publisher
	// does not allow.
	blocked map[string]bool
}

func loadAgentKeyContext(ctx context.Context, client *api.Client, subscribed []agentSubscriptionProvider) (agentKeyContext, error) {
	keyContext := agentKeyContext{served: map[string][]string{}, labels: map[string]string{}, subscriptions: map[string]string{}}
	for _, subscription := range subscribed {
		keyContext.subscriptions[subscription.routerProvider] = subscription.name
	}
	var listed struct {
		Credentials []agentProviderCredential `json:"credentials"`
	}
	if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials", nil, &listed); err != nil {
		return keyContext, api.HumanError(err)
	}
	keyContext.saved = agentAPIKeys(listed.Credentials)
	catalog, err := fetchAgentModelCatalog(ctx, client)
	if err != nil {
		return keyContext, err
	}
	for _, group := range catalog.Groups {
		keyContext.labels[group.Provider] = group.ProviderLabel
		for _, model := range group.Models {
			keyContext.served[group.Provider] = append(keyContext.served[group.Provider], model.ID)
		}
	}
	return keyContext, nil
}

func (c agentKeyContext) label(provider string) string {
	return cmp.Or(c.labels[provider], provider)
}

// sources lists a model's options, preferred first: a connected subscription
// for its provider, the user's key for its provider, a gateway key that
// serves it, then Dari credits.
func (c agentKeyContext) sources(model agentModel, provider string) []agentModelSource {
	var sources []agentModelSource
	if plan, ok := c.subscriptions[provider]; ok {
		sources = append(sources, agentModelSource{kind: "subscription", provider: provider, modelProvider: provider, label: plan + " Subscription"})
	}
	if subscriptionOnlyProviders[provider] {
		return sources
	}
	if key, ok := c.saved[provider]; ok {
		sources = append(sources, agentModelSource{kind: "key", provider: provider, modelProvider: provider, credentialID: key.ID, label: c.label(provider) + " Key"})
	}
	for _, gateway := range agentKeyGateways {
		if key, ok := c.saved[gateway.provider]; ok && slices.Contains(c.served[gateway.provider], model.ID) {
			sources = append(sources, agentModelSource{kind: "key", provider: gateway.provider, modelProvider: provider, credentialID: key.ID, label: gateway.name + " Key"})
		}
	}
	if model.SupportsManagedKey || len(sources) == 0 {
		sources = append(sources, agentModelSource{kind: "managed", provider: provider, modelProvider: provider, label: "Dari Credits"})
	}
	// A source the publisher blocks is none at all; a model left with none
	// cannot run.
	return slices.DeleteFunc(sources, func(source agentModelSource) bool { return c.blocked[source.kind] })
}

// sourcesPreferring is sources with the one a router already pays with moved
// first, when the model still offers it.
func (c agentKeyContext) sourcesPreferring(model agentModel, provider string, want agentModelSource) []agentModelSource {
	sources := c.sources(model, provider)
	i := slices.IndexFunc(sources, func(source agentModelSource) bool {
		return source.kind == want.kind && source.provider == want.provider
	})
	if i > 0 {
		picked := sources[i]
		sources = slices.Insert(slices.Delete(sources, i, i+1), 0, picked)
	}
	return sources
}

// keys turns each chosen model's source into router settings. A model on a
// subscription keeps the user's key for its provider, when there is one, as
// the fallback while the subscription is unavailable.
func (c agentKeyContext) keys(choices []agentModelChoice) agentProviderKeys {
	keys := agentProviderKeys{modelProviders: map[string]string{}, credentialIDs: map[string]string{}, subscriptionProviders: []string{}}
	for _, choice := range choices {
		source := choice.Source
		switch source.kind {
		case "subscription":
			if !slices.Contains(keys.subscriptionProviders, source.provider) {
				keys.subscriptionProviders = append(keys.subscriptionProviders, source.provider)
			}
			if key, ok := c.saved[source.provider]; ok && !c.blocked["key"] {
				keys.credentialIDs[source.provider] = key.ID
				keys.apiFallbackModels = append(keys.apiFallbackModels, choice.ID)
			}
		case "key":
			keys.modelProviders[choice.ID] = source.provider
			keys.credentialIDs[source.provider] = source.credentialID
		}
	}
	// A subscription chosen for only some of its provider's models names them.
	onSubscription, mixed := []string{}, false
	for _, choice := range choices {
		if !slices.Contains(keys.subscriptionProviders, choice.Source.modelProvider) {
			continue
		}
		if choice.Source.kind == "subscription" {
			onSubscription = append(onSubscription, choice.ID)
		} else {
			mixed = true
			keys.offSubscription = append(keys.offSubscription, choice.ID)
		}
	}
	if mixed {
		keys.subscriptionModels = onSubscription
	} else {
		keys.offSubscription = nil
	}
	return keys
}

// withSources gives each choice its source: the one it names when the model
// still offers it, else the preferred one. A model no source can pay for
// keeps none.
func (c agentKeyContext) withSources(models []agentModel, choices []agentModelChoice, providers map[string]string) []agentModelChoice {
	byID := map[string]agentModel{}
	for _, model := range models {
		byID[model.ID] = model
	}
	sourced := slices.Clone(choices)
	for i, choice := range sourced {
		sources := c.sources(byID[choice.ID], providers[choice.ID])
		named := slices.IndexFunc(sources, func(source agentModelSource) bool {
			return source.kind == choice.Source.kind && source.provider == choice.Source.provider
		})
		switch {
		case named >= 0:
			sourced[i].Source = sources[named]
		case len(sources) > 0:
			sourced[i].Source = sources[0]
		default:
			sourced[i].Source = agentModelSource{}
		}
	}
	return sourced
}

// agentSourceSummary names each source and the models it pays for.
func agentSourceSummary(models []agentModel, choices []agentModelChoice) string {
	names := map[string]string{}
	for _, model := range models {
		names[model.ID] = model.DisplayName
	}
	byLabel := map[string][]string{}
	var labels []string
	for _, choice := range choices {
		if _, ok := byLabel[choice.Source.label]; !ok {
			labels = append(labels, choice.Source.label)
		}
		byLabel[choice.Source.label] = append(byLabel[choice.Source.label], cmp.Or(names[choice.ID], choice.ID))
	}
	parts := make([]string, len(labels))
	for i, label := range labels {
		parts[i] = label + " for " + strings.Join(byLabel[label], ", ")
	}
	return strings.Join(parts, "; ")
}

// agentProviderKeysFor routes models onto their preferred sources, for
// routers set up without the model picker.
func agentProviderKeysFor(
	ctx context.Context,
	client *api.Client,
	stderr io.Writer,
	models []agentModel,
	ids []string,
	providers map[string]string,
	subscribed []agentSubscriptionProvider,
) (agentProviderKeys, error) {
	keyContext, err := loadAgentKeyContext(ctx, client, subscribed)
	if err != nil {
		return agentProviderKeys{}, err
	}
	choices := make([]agentModelChoice, len(ids))
	for i, id := range ids {
		choices[i] = agentModelChoice{ID: id}
	}
	choices = keyContext.withSources(models, choices, providers)
	agentStep(stderr, "Paying with "+agentSourceSummary(models, choices))
	return keyContext.keys(choices), nil
}

// applyAgentProviderKeys moves the models a router already serves onto the
// API keys connected on the Accounts page. Routers set up earlier skip the
// model picker, where new routers apply them.
func applyAgentProviderKeys(ctx context.Context, client *api.Client, routerID string, stderr io.Writer) error {
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
	subscribed := slices.DeleteFunc([]agentSubscriptionProvider{claudeSubscription, codexSubscription, museSubscription}, func(subscription agentSubscriptionProvider) bool {
		return !slices.Contains(router.SubscriptionProviders, subscription.routerProvider)
	})
	keys, err := agentProviderKeysFor(ctx, client, stderr, models, body.EnabledModels, body.ModelProviders, subscribed)
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
	// A per-model payment choice made in the picker is saved here too, on top
	// of the router's own: only the models the picker decided change.
	if keys.subscriptionModels != nil {
		served := slices.DeleteFunc(slices.Clone(router.SubscriptionModels), func(model string) bool {
			return slices.Contains(keys.offSubscription, model)
		})
		for _, model := range keys.subscriptionModels {
			if slices.Contains(body.EnabledModels, model) && !slices.Contains(served, model) {
				served = append(served, model)
			}
		}
		if !sameModelSet(served, router.SubscriptionModels) {
			body.SubscriptionModels = &served
		}
	}
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

// saveAgentAPIKey asks for a provider's API key on its own page and saves it
// as an organization credential. It reports whether one was saved; esc
// saves none.
func saveAgentAPIKey(ctx context.Context, client *api.Client, stdin io.Reader, stderr io.Writer, provider, name string) (bool, error) {
	saved, err := runAgentSecretInputTUI(stdin, stderr, name+" API Key", nil, func(key string) error {
		var created agentProviderCredential
		if err := client.Do(ctx, http.MethodPost, "/v1/organizations/current/credentials/provider-credentials", map[string]any{
			"provider": provider,
			"label":    name,
			"auth":     map[string]string{"type": "api_key", "api_key": key},
		}, &created); err != nil {
			return api.HumanError(err)
		}
		if created.ID == "" {
			return fmt.Errorf("Dari did not return the saved %s credential", name)
		}
		return nil
	})
	if saved {
		agentStep(stderr, "Connected your "+name+" key")
	}
	return saved, err
}
