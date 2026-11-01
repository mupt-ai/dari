package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/mupt-ai/dari-cli/internal/api"
	"github.com/mupt-ai/dari-cli/internal/auth"
)

// agentSetup is how dari sets up one coding agent's routing.
type agentSetup struct {
	label string
	// suggestion is the model preset the model picker starts from, the same
	// one the frontend shows.
	suggestion string
	// subscriptions are the personal subscriptions the agent can use, its own
	// first: a ChatGPT plan serves OpenAI models to any client, while Claude
	// Code and Muse Code plans serve only their own agent.
	subscriptions []agentSubscriptionProvider
	// routerKey names the router the agent sets up for itself; empty shares
	// the organization's default router.
	routerKey string
}

// agentSetups are the agents dari sets up, by launcher name.
var agentSetups = map[string]agentSetup{
	"claude":   {label: "Claude Code", suggestion: "claude", subscriptions: []agentSubscriptionProvider{claudeSubscription, codexSubscription}, routerKey: "dari-cli:claude-code"},
	"codex":    {label: "Codex", suggestion: "codex", subscriptions: []agentSubscriptionProvider{codexSubscription}, routerKey: "dari-cli:codex"},
	"muse":     {label: "Muse Code", suggestion: "muse", subscriptions: []agentSubscriptionProvider{museSubscription}, routerKey: "dari-cli:muse-code"},
	"opencode": {label: "OpenCode", suggestion: "default", subscriptions: []agentSubscriptionProvider{codexSubscription}},
	"pi":       {label: "Pi", suggestion: "default", subscriptions: []agentSubscriptionProvider{codexSubscription}},
}

// ownsRouter reports whether the agent sets up a router of its own.
func (setup agentSetup) ownsRouter() bool {
	return setup.routerKey != ""
}

// ownRouter is the agent's own router's client key and name: one serving the
// user's personal subscriptions, or a managed one without them.
func (setup agentSetup) ownRouter(personal bool) (clientKey, name string) {
	if personal {
		return setup.routerKey, "Dari " + setup.label
	}
	return setup.routerKey + "-managed", "Dari " + setup.label + " (Managed)"
}

var openAgentBrowser = auth.OpenBrowser

type agentRoutingAccess struct {
	apiURL string
	scope  string
	key    string
	// keysAdded counts the API keys connected with --connect.
	keysAdded int
}

type agentRouter struct {
	ID                            string              `json:"id"`
	Name                          string              `json:"name"`
	ClientKey                     string              `json:"client_key"`
	IsDefault                     bool                `json:"is_default"`
	EnabledModels                 []string            `json:"enabled_models"`
	ModelProviders                map[string]string   `json:"model_providers"`
	ModelThinkingLevels           map[string][]string `json:"model_thinking_levels"`
	SubscriptionProviders         []string            `json:"subscription_providers"`
	SubscriptionAPIFallbackModels []string            `json:"subscription_api_fallback_models"`
	SessionPinning                bool                `json:"session_pinning"`
}

type agentModel struct {
	ID                   string   `json:"id"`
	DisplayName          string   `json:"display_name"`
	Provider             string   `json:"provider"`
	DefaultProvider      string   `json:"default_provider"`
	DefaultThinkingLevel string   `json:"default_thinking_level"`
	SupportedLevels      []string `json:"supported_thinking_levels"`
	SupportsManagedKey   bool     `json:"supports_managed_key"`
}

type agentModelCatalog struct {
	Groups []struct {
		Provider           string       `json:"provider"`
		ProviderLabel      string       `json:"provider_label"`
		SupportsManagedKey bool         `json:"supports_managed_key"`
		Models             []agentModel `json:"models"`
	} `json:"groups"`
}

type agentModelChoice struct {
	ID     string
	Levels []string
	// Source is where the model's requests are paid for; empty uses the
	// model's preferred source.
	Source agentModelSource
}

type agentRouterCreateRequest struct {
	Name                          string              `json:"name"`
	ClientKey                     string              `json:"client_key"`
	EnabledModels                 []string            `json:"enabled_models"`
	ModelProviders                map[string]string   `json:"model_providers"`
	ProviderKeySources            map[string]string   `json:"provider_key_sources"`
	ProviderCredentialIDs         map[string]string   `json:"provider_credential_ids,omitempty"`
	ModelThinkingLevels           map[string][]string `json:"model_thinking_levels"`
	RoutingStrategy               string              `json:"routing_strategy"`
	SpeculativeRouting            bool                `json:"speculative_routing"`
	SessionPinning                bool                `json:"session_pinning"`
	PrimaryRetries                int                 `json:"primary_retries"`
	SubscriptionProviders         []string            `json:"subscription_providers"`
	SubscriptionAPIFallbackModels []string            `json:"subscription_api_fallback_models"`
	EvalScoreImputation           bool                `json:"eval_score_imputation"`
}

type agentRouterUpdateRequest struct {
	Name                  string              `json:"name"`
	EnabledModels         []string            `json:"enabled_models"`
	ModelProviders        map[string]string   `json:"model_providers"`
	ProviderKeySources    map[string]string   `json:"provider_key_sources,omitempty"`
	ProviderCredentialIDs map[string]string   `json:"provider_credential_ids,omitempty"`
	ModelThinkingLevels   map[string][]string `json:"model_thinking_levels"`
	// Omitted keeps the router's current API fallback models.
	SubscriptionAPIFallbackModels []string `json:"subscription_api_fallback_models,omitempty"`
	SessionPinning                bool     `json:"session_pinning"`
}

// Omitting subscription_api_fallback_models keeps the router's current ones.
type agentRouterSubscriptionUpdateRequest struct {
	Name                  string              `json:"name"`
	EnabledModels         []string            `json:"enabled_models"`
	ModelProviders        map[string]string   `json:"model_providers,omitempty"`
	ModelThinkingLevels   map[string][]string `json:"model_thinking_levels,omitempty"`
	SubscriptionProviders []string            `json:"subscription_providers"`
}

type agentCredential struct {
	OAuthProvider string `json:"oauth_provider"`
}

type agentSubscriptionOAuthStart struct {
	SessionToken     string `json:"session_token"`
	AuthorizationURL string `json:"authorization_url"`
	UserCode         string `json:"user_code,omitempty"`
}

type agentSubscriptionResolution struct {
	enabled           bool
	decided           bool
	preferenceChanged bool
	connectedNow      bool
	// keysAdded counts the API keys connected on the Accounts page.
	keysAdded int
}

func resolveAgentRoutingAccess(
	ctx context.Context,
	stdin io.Reader,
	stderr io.Writer,
) (agentRoutingAccess, error) {
	apiURL, err := (&globalFlags{}).resolveAPIURL()
	if err != nil {
		return agentRoutingAccess{}, err
	}
	scope, err := agentKeyScope(ctx, apiURL, stdin, stderr)
	if err != nil {
		return agentRoutingAccess{}, err
	}
	key, err := resolveAgentRoutingKeyForScope(ctx, apiURL, scope, stderr)
	if err != nil {
		return agentRoutingAccess{}, err
	}
	return agentRoutingAccess{apiURL: apiURL, scope: scope, key: key}, nil
}

func ensureAgentRouter(
	ctx context.Context,
	agent string,
	access agentRoutingAccess,
	stdin io.Reader,
	stderr io.Writer,
) (string, error) {
	setup, ok := agentSetups[agent]
	if !ok {
		return "default", nil
	}

	client, err := auth.OrgKeyClient(access.apiURL)
	if err != nil {
		return "", err
	}
	// API keys connected on the Accounts page apply once the router's models
	// are known. Routers set up earlier skip the model picker, so their
	// current models move onto the new keys.
	keysAdded := access.keysAdded
	configured := func(routerID string) (string, error) {
		if keysAdded == 0 {
			return routerID, nil
		}
		return routerID, applyAgentProviderKeys(ctx, client, routerID, stderr)
	}
	routers, err := listAgentRouters(ctx, client)
	if err != nil {
		return "", err
	}
	defaultRouter, ok := findAgentRouter(routers, func(router agentRouter) bool {
		return router.IsDefault
	})
	if !ok {
		return "", errors.New("organization has no default router")
	}

	if !setup.ownsRouter() {
		accountKeys, err := ensureDefaultAgentSubscription(ctx, agent, client, defaultRouter, stdin, stderr)
		if err != nil {
			return "", err
		}
		keysAdded += accountKeys
		// Reuse server configuration; once configured, other computers skip
		// the picker too.
		if len(defaultRouter.EnabledModels) > 0 {
			return configured(defaultRouter.ID)
		}
	}

	// The personal subscriptions an agent's own router serves; none means its
	// managed router.
	var subscribed []agentSubscriptionProvider
	ownClientKey := ""
	if setup.ownsRouter() {
		previouslyOptedOut, err := agentSubscriptionOptedOut(ctx, client, agent)
		if err != nil {
			return "", err
		}
		resolution, err := resolveAgentPersonalSubscription(
			ctx,
			setup.subscriptions,
			client,
			stdin,
			stderr,
			previouslyOptedOut,
		)
		if err != nil {
			return "", err
		}
		keysAdded += resolution.keysAdded
		if !resolution.decided {
			managedKey, _ := setup.ownRouter(false)
			if existing, found := findAgentRouter(routers, func(router agentRouter) bool {
				return router.ClientKey == managedKey
			}); found {
				return configured(existing.ID)
			}
			return configured(defaultRouter.ID)
		}
		if resolution.preferenceChanged {
			if err := saveAgentSubscriptionOptOut(ctx, client, agent, !resolution.enabled); err != nil {
				return "", err
			}
		}
		if resolution.enabled {
			if subscribed, err = connectedAgentSubscriptions(ctx, client, setup.subscriptions); err != nil {
				return "", err
			}
		}
		ownClientKey, _ = setup.ownRouter(len(subscribed) > 0)
		existing, found := findAgentRouter(routers, func(router agentRouter) bool {
			return router.ClientKey == ownClientKey
		})
		if found {
			if err := setOwnRouterSubscriptions(ctx, client, existing, setup, subscribed); err != nil {
				return "", err
			}
			return configured(existing.ID)
		}
	}

	title := "Choose models for " + setup.label
	suggestion, err := fetchAgentModelSuggestion(ctx, client, setup.suggestion)
	if err != nil {
		return "", err
	}
	defaultIDs := suggestion.modelIDs
	recommendedLevels := suggestion.levels

	models, err := listAgentModels(ctx, client)
	if err != nil {
		return "", err
	}
	if !setup.ownsRouter() {
		models = includeCurrentAgentModels(models, defaultRouter)
	}
	var currentLevels map[string][]string
	// Each model offers the subscriptions, keys, and credits that can pay for
	// it, preferred first; the picker lets the user change any of them.
	if !setup.ownsRouter() {
		subscribed = slices.DeleteFunc(slices.Clone(setup.subscriptions), func(subscription agentSubscriptionProvider) bool {
			return !slices.Contains(defaultRouter.SubscriptionProviders, subscription.routerProvider)
		})
	}
	keyContext, err := loadAgentKeyContext(ctx, client, subscribed)
	if err != nil {
		return "", err
	}
	modelProviders := agentProvidersFor(models, modelIDs(models))
	sources := map[string][]agentModelSource{}
	for _, model := range models {
		sources[model.ID] = keyContext.sources(model, modelProviders[model.ID])
	}
	var choices []agentModelChoice
	for {
		routing, err := autoroutingAllowed(ctx, client)
		if err != nil {
			return "", err
		}
		note := []string{"The checked models are recommended. Auto-routing picks the best of these for each request."}
		if !routing {
			offer := "Run `dari " + agent + " --connect` to get auto-routing ($20/mo) and have Dari pick for you."
			if agentInputIsTerminal(stdin) {
				offer = "Press a to get auto-routing ($20/mo) and have Dari pick for you."
			}
			note = []string{"The checked models are recommended. Switch between them with /model.", offer}
		}
		choices, err = selectAgentModels(stdin, stderr, title, note, !routing, models, defaultIDs, currentLevels, recommendedLevels, sources)
		if !errors.Is(err, errAgentWantsAutorouting) {
			if err != nil {
				return "", err
			}
			break
		}
		if _, err := getAutorouting(ctx, client, stdin, stderr); err != nil {
			return "", err
		}
	}
	choices = keyContext.withSources(models, choices, modelProviders)
	agentStep(stderr, "Paying with "+agentSourceSummary(models, choices))
	keys := keyContext.keys(choices)
	routerID := defaultRouter.ID
	if !setup.ownsRouter() {
		body := agentRouterUpdateBody(defaultRouter, models, choices)
		keys.apply(body.ModelProviders, body.ProviderKeySources)
		body.ProviderCredentialIDs = keys.credentialIDs
		body.SubscriptionAPIFallbackModels = keys.fallbackModels(defaultRouter.SubscriptionAPIFallbackModels, body.EnabledModels)
		if body.SessionPinning, err = chooseAgentSessionPinning(stdin, stderr, defaultRouter.SessionPinning); err != nil {
			return "", err
		}
		if len(keys.credentialIDs) > 0 || body.SessionPinning != defaultRouter.SessionPinning || agentRouterNeedsUpdate(defaultRouter, choices) {
			if defaultRouter, err = putAgentRouter(ctx, client, defaultRouter.ID, body); err != nil {
				return "", err
			}
		}
		agentStep(stderr, setup.label+" will use your default router")
	} else {
		body := agentRouterCreateBody(setup, models, choices, subscribed)
		// The agent's own plan must have a model to serve, or connecting it
		// did nothing.
		if len(subscribed) > 0 && subscribed[0] == setup.subscriptions[0] &&
			!slices.Contains(slices.Collect(maps.Values(body.ModelProviders)), subscribed[0].routerProvider) {
			return "", fmt.Errorf("a %s subscription needs at least one selected model served directly by %s", subscribed[0].name, subscribed[0].vendor)
		}
		keys.apply(body.ModelProviders, body.ProviderKeySources)
		body.ProviderCredentialIDs = keys.credentialIDs
		body.SubscriptionProviders = keys.subscriptionProviders
		if fallback := keys.fallbackModels(nil, body.EnabledModels); fallback != nil {
			body.SubscriptionAPIFallbackModels = fallback
		}
		body.SessionPinning, err = chooseAgentSessionPinning(stdin, stderr, false)
		if err != nil {
			return "", err
		}
		var created agentRouter
		createErr := client.Do(ctx, http.MethodPost, "/v1/organizations/current/routers", body, &created)
		if createErr == nil {
			routerID = created.ID
			agentStep(stderr, setup.label+" router created")
		} else if api.AsHTTPError(createErr) != nil && api.AsHTTPError(createErr).Status == http.StatusConflict {
			routers, err := listAgentRouters(ctx, client)
			if err != nil {
				return "", err
			}
			existing, found := findAgentRouter(routers, func(router agentRouter) bool {
				return router.ClientKey == ownClientKey
			})
			if !found {
				return "", api.HumanError(createErr)
			}
			// Another launch created the router first; keep its models and
			// attach the keys chosen here.
			if len(keys.credentialIDs) > 0 {
				if existing, err = attachAgentProviderKeys(ctx, client, existing, models, keys); err != nil {
					return "", err
				}
			}
			if err := setOwnRouterSubscriptions(ctx, client, existing, setup, subscribed); err != nil {
				return "", err
			}
			routerID = existing.ID
		} else {
			return "", api.HumanError(createErr)
		}
	}
	return routerID, nil
}

// connectedAgentSubscriptions are the providers whose personal subscription
// the user has connected.
func connectedAgentSubscriptions(ctx context.Context, client *api.Client, providers []agentSubscriptionProvider) ([]agentSubscriptionProvider, error) {
	var listed agentSubscriptionStatus
	if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials", nil, &listed); err != nil {
		return nil, api.HumanError(err)
	}
	return slices.DeleteFunc(slices.Clone(providers), func(provider agentSubscriptionProvider) bool {
		return !slices.ContainsFunc(listed.Credentials, func(credential agentCredential) bool {
			return credential.OAuthProvider == provider.id
		})
	}), nil
}

// setOwnRouterSubscriptions adds the connected subscriptions to an agent's
// own router, or with none connected takes the agent's subscriptions off it.
func setOwnRouterSubscriptions(ctx context.Context, client *api.Client, router agentRouter, setup agentSetup, subscribed []agentSubscriptionProvider) error {
	if len(subscribed) == 0 {
		return setAgentRouterSubscription(ctx, client, router, setup.subscriptions, false)
	}
	return setAgentRouterSubscription(ctx, client, router, subscribed, true)
}

// resolveAgentPersonalSubscription decides whether a launch uses the agent's
// personal subscriptions: its own one already connected, or the ones the user
// keeps or connects on the Accounts page. Without a terminal it asks about
// the agent's own provider only.
func resolveAgentPersonalSubscription(
	ctx context.Context,
	providers []agentSubscriptionProvider,
	client *api.Client,
	stdin io.Reader,
	stderr io.Writer,
	previouslyOptedOut bool,
) (agentSubscriptionResolution, error) {
	// Only the agent's own subscription decides without asking: a ChatGPT
	// account connected for Codex does not set up Claude Code.
	own, err := connectedAgentSubscriptions(ctx, client, providers[:1])
	if err != nil {
		return agentSubscriptionResolution{}, err
	}
	if len(own) > 0 {
		return agentSubscriptionResolution{enabled: true, decided: true, preferenceChanged: previouslyOptedOut}, nil
	}
	if previouslyOptedOut {
		return agentSubscriptionResolution{decided: true}, nil
	}

	if agentInputIsTerminal(stdin) {
		added, keysAdded, err := manageAgentSubscriptions(ctx, client, providers, stdin, stderr)
		if added == 0 {
			// A failed page with nothing connected records no preference.
			if err != nil {
				return agentSubscriptionResolution{}, err
			}
			// Continuing with subscriptions the page already listed uses them.
			connected, err := connectedAgentSubscriptions(ctx, client, providers)
			if err != nil {
				return agentSubscriptionResolution{}, err
			}
			return agentSubscriptionResolution{enabled: len(connected) > 0, decided: true, preferenceChanged: true, keysAdded: keysAdded}, nil
		}
		// Accounts connected before an error are stored, so report them as
		// connected alongside the error.
		return agentSubscriptionResolution{enabled: true, decided: true, preferenceChanged: true, connectedNow: true, keysAdded: keysAdded}, err
	}
	provider := providers[0]
	useSubscription, answered, err := confirmDefaultYes(
		stdin,
		stderr,
		"Use your "+provider.name+" personal subscription? [Y/n] ",
	)
	if err != nil {
		return agentSubscriptionResolution{}, err
	}
	if !answered {
		return agentSubscriptionResolution{}, nil
	}
	if !useSubscription {
		return agentSubscriptionResolution{decided: true, preferenceChanged: true}, nil
	}
	if err := connectAgentPersonalSubscription(ctx, provider, client, stdin, stderr, ""); err != nil {
		return agentSubscriptionResolution{}, err
	}
	return agentSubscriptionResolution{enabled: true, decided: true, preferenceChanged: true, connectedNow: true}, nil
}

// connectAgentPersonalSubscription connects another subscription, or
// reconnects the one named by credentialName when it is non-empty.
func connectAgentPersonalSubscription(
	ctx context.Context,
	provider agentSubscriptionProvider,
	client *api.Client,
	stdin io.Reader,
	stderr io.Writer,
	credentialName string,
) error {
	body := map[string]string{"provider": provider.id}
	if credentialName != "" {
		body["credential_name"] = credentialName
	}
	var started agentSubscriptionOAuthStart
	if err := client.Do(
		ctx,
		http.MethodPost,
		"/v1/organizations/current/credentials/oauth/sessions",
		body,
		&started,
	); err != nil {
		return api.HumanError(err)
	}
	if strings.TrimSpace(started.SessionToken) == "" || strings.TrimSpace(started.AuthorizationURL) == "" {
		return fmt.Errorf("Dari returned an incomplete %s authorization session", provider.name)
	}

	if provider.deviceCode {
		if strings.TrimSpace(started.UserCode) == "" {
			return fmt.Errorf("Dari returned a %s authorization session without a device code", provider.name)
		}
		return connectAgentDeviceCodeSubscription(ctx, provider, client, stdin, stderr, started)
	}

	opened := openAgentBrowser(started.AuthorizationURL)
	if agentInputIsTerminal(stdin) {
		authorizationResponse, err := runAgentCodeInputTUI(provider, stdin, stderr, started.AuthorizationURL, opened)
		if err != nil {
			return err
		}
		return completeAgentPersonalSubscription(ctx, provider, client, stderr, started.SessionToken, authorizationResponse)
	}

	writeAgentOAuthInstructions(provider, stderr, started.AuthorizationURL, opened)
	fmt.Fprintf(stderr, "After approving, paste the authorization code %s shows: ", provider.vendor)
	authorizationResponse, err := readAgentLine(stdin)
	if err != nil {
		return fmt.Errorf("read %s authorization code: %w", provider.name, err)
	}
	return completeAgentPersonalSubscription(ctx, provider, client, stderr, started.SessionToken, authorizationResponse)
}

func connectAgentDeviceCodeSubscription(
	ctx context.Context,
	provider agentSubscriptionProvider,
	client *api.Client,
	stdin io.Reader,
	stderr io.Writer,
	started agentSubscriptionOAuthStart,
) error {
	opened := openAgentBrowser(started.AuthorizationURL)
	complete := func() error {
		return completeAgentPersonalSubscription(ctx, provider, client, stderr, started.SessionToken, "")
	}
	pending := func(err error) bool {
		return err != nil && strings.HasPrefix(err.Error(), provider.vendor+" approval is still pending.")
	}
	if agentInputIsTerminal(stdin) {
		err := runAgentDeviceCodeTUI(provider, stdin, stderr, started.AuthorizationURL, started.UserCode, opened, func() (bool, error) {
			// The result is reported after the prompt is erased.
			err := completeAgentPersonalSubscriptionQuietly(ctx, client, started.SessionToken, "")
			return pending(err), err
		})
		if err != nil {
			return err
		}
		agentStep(stderr, provider.name+" subscription connected")
		return nil
	}
	writeAgentOAuthInstructions(provider, stderr, started.AuthorizationURL, opened)
	fmt.Fprintf(stderr, "Enter this code at %s: %s\n", provider.vendor, started.UserCode)
	for {
		fmt.Fprintln(stderr, "After approving access, press Enter here to finish connecting.")
		if _, err := readAgentLine(stdin); err != nil {
			return fmt.Errorf("read %s approval: %w", provider.name, err)
		}
		err := complete()
		if pending(err) {
			fmt.Fprintln(stderr, err)
			continue
		}
		return err
	}
}

func completeAgentPersonalSubscription(
	ctx context.Context,
	provider agentSubscriptionProvider,
	client *api.Client,
	stderr io.Writer,
	sessionToken string,
	authorizationResponse string,
) error {
	if strings.TrimSpace(authorizationResponse) == "" && !provider.deviceCode {
		return fmt.Errorf("%s authorization was not completed", provider.name)
	}
	if err := completeAgentPersonalSubscriptionQuietly(ctx, client, sessionToken, authorizationResponse); err != nil {
		return err
	}
	agentStep(stderr, provider.name+" subscription connected")
	return nil
}

func completeAgentPersonalSubscriptionQuietly(ctx context.Context, client *api.Client, sessionToken, authorizationResponse string) error {
	if err := client.Do(
		ctx,
		http.MethodPost,
		"/v1/organizations/current/credentials/oauth/sessions/complete",
		map[string]string{
			"session_token":          sessionToken,
			"authorization_response": authorizationResponse,
		},
		nil,
	); err != nil {
		return api.HumanError(err)
	}
	return nil
}

func writeAgentOAuthInstructions(provider agentSubscriptionProvider, stderr io.Writer, authorizationURL string, opened bool) {
	if opened {
		fmt.Fprintf(stderr, "Opened %s login in your browser. If it did not open, visit:\n  %s\n", provider.name, authorizationURL)
	} else {
		fmt.Fprintf(stderr, "Open this URL to connect your %s subscription:\n  %s\n", provider.name, authorizationURL)
	}
}

func confirmDefaultYes(stdin io.Reader, stderr io.Writer, prompt string) (bool, bool, error) {
	fmt.Fprint(stderr, prompt)
	answer, err := readAgentLine(stdin)
	if errors.Is(err, io.EOF) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "", "y", "yes":
		return true, true, nil
	case "n", "no":
		return false, true, nil
	default:
		return false, true, fmt.Errorf("expected yes or no, got %q", strings.TrimSpace(answer))
	}
}

func readAgentLine(stdin io.Reader) (string, error) {
	var line strings.Builder
	for {
		var chunk [1]byte
		n, readErr := stdin.Read(chunk[:])
		if n > 0 {
			if chunk[0] == '\n' {
				return line.String(), nil
			}
			line.WriteByte(chunk[0])
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) && line.Len() > 0 {
				return line.String(), nil
			}
			return "", readErr
		}
	}
}

// setAgentRouterSubscription adds the subscriptions' providers to, or removes
// them from, the router's subscription providers. Providers without enabled
// models on the router are skipped, and API fallback models stay as they are.
func setAgentRouterSubscription(
	ctx context.Context,
	client *api.Client,
	router agentRouter,
	subscriptions []agentSubscriptionProvider,
	enabled bool,
) error {
	providers := slices.DeleteFunc(slices.Clone(router.SubscriptionProviders), func(provider string) bool {
		return !enabled && slices.ContainsFunc(subscriptions, func(s agentSubscriptionProvider) bool { return s.routerProvider == provider })
	})
	if enabled {
		served := slices.Collect(maps.Values(router.ModelProviders))
		for _, subscription := range subscriptions {
			if !slices.Contains(providers, subscription.routerProvider) && slices.Contains(served, subscription.routerProvider) {
				providers = append(providers, subscription.routerProvider)
			}
		}
	}
	if providers == nil {
		providers = []string{}
	}
	if sameStringSet(providers, router.SubscriptionProviders) {
		return nil
	}
	if strings.TrimSpace(router.Name) == "" || len(router.EnabledModels) == 0 {
		return errors.New("Dari returned an incomplete agent router")
	}
	body := agentRouterSubscriptionUpdateRequest{
		Name:                  router.Name,
		EnabledModels:         router.EnabledModels,
		ModelProviders:        router.ModelProviders,
		ModelThinkingLevels:   router.ModelThinkingLevels,
		SubscriptionProviders: providers,
	}
	path := "/v1/organizations/current/routers/" + url.PathEscape(router.ID)
	// Decode into a fresh router so the caller's maps are not merged with the response.
	var updated agentRouter
	if err := client.Do(ctx, http.MethodPut, path, body, &updated); err != nil {
		return api.HumanError(err)
	}
	return nil
}

func listAgentRouters(ctx context.Context, client *api.Client) ([]agentRouter, error) {
	var listed struct {
		Routers []agentRouter `json:"routers"`
	}
	if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/routers", nil, &listed); err != nil {
		return nil, api.HumanError(err)
	}
	return listed.Routers, nil
}

func findAgentRouter(
	routers []agentRouter,
	match func(agentRouter) bool,
) (agentRouter, bool) {
	for _, router := range routers {
		if match(router) {
			return router, true
		}
	}
	return agentRouter{}, false
}

func fetchAgentModelCatalog(ctx context.Context, client *api.Client) (agentModelCatalog, error) {
	var catalog agentModelCatalog
	if err := client.Do(
		ctx,
		http.MethodGet,
		"/v1/organizations/current/routers/model-catalog",
		nil,
		&catalog,
	); err != nil {
		return agentModelCatalog{}, api.HumanError(err)
	}
	return catalog, nil
}

func listAgentModels(ctx context.Context, client *api.Client) ([]agentModel, error) {
	catalog, err := fetchAgentModelCatalog(ctx, client)
	if err != nil {
		return nil, err
	}
	models := []agentModel{}
	for _, group := range catalog.Groups {
		if !group.SupportsManagedKey {
			continue
		}
		for _, model := range group.Models {
			if !model.SupportsManagedKey {
				continue
			}
			models = append(models, model)
		}
	}
	sort.SliceStable(models, func(i, j int) bool {
		return strings.ToLower(models[i].DisplayName) < strings.ToLower(models[j].DisplayName)
	})
	return models, nil
}

func includeCurrentAgentModels(models []agentModel, current agentRouter) []agentModel {
	known := make(map[string]bool, len(models))
	for _, model := range models {
		known[model.ID] = true
	}
	for _, modelID := range current.EnabledModels {
		if known[modelID] {
			continue
		}
		models = append(models, agentModel{
			ID:              modelID,
			DisplayName:     modelID,
			Provider:        current.ModelProviders[modelID],
			DefaultProvider: current.ModelProviders[modelID],
		})
	}
	return models
}

// selectAgentModels asks which models the router uses; note explains them
// under the title. With offerAutorouting, pressing a returns
// errAgentWantsAutorouting.
func selectAgentModels(
	stdin io.Reader,
	stderr io.Writer,
	title string,
	note []string,
	offerAutorouting bool,
	models []agentModel,
	defaults []string,
	currentLevels map[string][]string,
	recommendedLevels map[string][]string,
	sources map[string][]agentModelSource,
) ([]agentModelChoice, error) {
	if agentInputIsTerminal(stdin) {
		return runAgentPicker(stdin, stderr, title, note, offerAutorouting, models, defaults, currentLevels, recommendedLevels, sources)
	}
	return selectAgentModelsByNumber(stdin, stderr, title, note, models, defaults, currentLevels, recommendedLevels)
}

func selectAgentModelsByNumber(
	stdin io.Reader,
	stderr io.Writer,
	title string,
	note []string,
	models []agentModel,
	defaults []string,
	currentLevels map[string][]string,
	recommendedLevels map[string][]string,
) ([]agentModelChoice, error) {
	byID := make(map[string]agentModel, len(models))
	for _, model := range models {
		byID[model.ID] = model
	}

	fmt.Fprintf(stderr, "\n%s\n", title)
	for _, line := range note {
		fmt.Fprintln(stderr, line)
	}
	fmt.Fprintln(stderr)
	for i, model := range models {
		mark := " "
		if slices.Contains(defaults, model.ID) {
			mark = "x"
		}
		fmt.Fprintf(stderr, "  %2d. [%s] %s\n", i+1, mark, model.DisplayName)
	}
	fmt.Fprintln(stderr, "\nEnter model numbers separated by commas, or press Enter to keep the checked models.")
	fmt.Fprint(stderr, "> ")

	// Read via readAgentLine so unconsumed stdin still reaches the agent
	// process launched after setup.
	line, readErr := readAgentLine(stdin)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return nil, fmt.Errorf("read model selection: %w", readErr)
	}
	input := strings.TrimSpace(line)
	if input == "" {
		if len(defaults) == 0 {
			return nil, errors.New("at least one model must be selected")
		}
		choices := make([]agentModelChoice, 0, len(defaults))
		for _, id := range defaults {
			choices = append(choices, agentModelChoice{
				ID:     id,
				Levels: defaultLevelsFor(byID[id], currentLevels[id], recommendedLevels[id]),
			})
		}
		return choices, nil
	}

	chosen := []agentModelChoice{}
	for _, raw := range strings.Split(input, ",") {
		index, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || index < 1 || index > len(models) {
			return nil, fmt.Errorf("invalid model number %q", strings.TrimSpace(raw))
		}
		model := models[index-1]
		if !slices.ContainsFunc(chosen, func(choice agentModelChoice) bool { return choice.ID == model.ID }) {
			chosen = append(chosen, agentModelChoice{
				ID:     model.ID,
				Levels: defaultLevelsFor(model, currentLevels[model.ID], recommendedLevels[model.ID]),
			})
		}
	}
	if len(chosen) == 0 {
		return nil, errors.New("at least one model must be selected")
	}
	return chosen, nil
}

func defaultLevelsFor(model agentModel, current, recommended []string) []string {
	if len(current) > 0 {
		return append([]string(nil), current...)
	}
	if len(recommended) > 0 {
		return append([]string(nil), recommended...)
	}
	if model.DefaultThinkingLevel != "" {
		return []string{model.DefaultThinkingLevel}
	}
	if len(model.SupportedLevels) > 0 {
		return []string{model.SupportedLevels[0]}
	}
	return nil
}

type agentPickerRow struct {
	model       agentModel
	levelOpts   []string
	recommended map[string]bool
	checked     map[string]bool
	selected    bool
	// sources are where the model can be paid for, preferred first; source
	// indexes the chosen one.
	sources []agentModelSource
	source  int
}

func (row *agentPickerRow) checkedLevels() []string {
	levels := []string{}
	for _, level := range row.levelOpts {
		if row.checked[level] {
			levels = append(levels, level)
		}
	}
	return levels
}

func (row *agentPickerRow) recommendedLevels() []string {
	levels := make([]string, 0, len(row.recommended))
	for _, level := range row.levelOpts {
		if row.recommended[level] {
			levels = append(levels, level)
		}
	}
	return levels
}

func (row *agentPickerRow) usesRecommended() bool {
	if len(row.recommended) == 0 {
		return false
	}
	levels := row.checkedLevels()
	if len(levels) != len(row.recommended) {
		return false
	}
	for _, level := range levels {
		if !row.recommended[level] {
			return false
		}
	}
	return true
}

type agentPickerState struct {
	rows        []agentPickerRow
	cursor      int
	offset      int
	editing     bool
	levelCursor int
}

func newAgentPickerState(
	models []agentModel,
	defaults []string,
	currentLevels map[string][]string,
	recommendedLevels map[string][]string,
	sources map[string][]agentModelSource,
) *agentPickerState {
	state := &agentPickerState{rows: make([]agentPickerRow, 0, len(models))}
	for _, model := range models {
		row := newAgentPickerRow(model, currentLevels[model.ID], recommendedLevels[model.ID])
		row.selected = slices.Contains(defaults, model.ID)
		row.sources = sources[model.ID]
		state.rows = append(state.rows, row)
	}
	return state
}

func newAgentPickerRow(model agentModel, current, recommended []string) agentPickerRow {
	row := agentPickerRow{
		model:       model,
		recommended: make(map[string]bool, len(recommended)),
		checked:     map[string]bool{},
	}
	for _, level := range recommended {
		row.recommended[level] = true
	}
	initial := defaultLevelsFor(model, current, recommended)
	for _, levels := range [][]string{model.SupportedLevels, initial, recommended} {
		for _, level := range levels {
			if level != "" && !slices.Contains(row.levelOpts, level) {
				row.levelOpts = append(row.levelOpts, level)
			}
		}
	}
	for _, level := range initial {
		row.checked[level] = true
	}
	return row
}

func (p *agentPickerState) selectedCount() int {
	count := 0
	for _, row := range p.rows {
		if row.selected {
			count++
		}
	}
	return count
}

func (p *agentPickerState) choices() []agentModelChoice {
	choices := make([]agentModelChoice, 0, p.selectedCount())
	for _, row := range p.rows {
		if row.selected {
			choice := agentModelChoice{ID: row.model.ID, Levels: row.checkedLevels()}
			if len(row.sources) > 0 {
				choice.Source = row.sources[row.source]
			}
			choices = append(choices, choice)
		}
	}
	return choices
}

// cycleSource moves a model to its next source. A subscription, the
// provider's own key, and credits apply per provider on a router, so models of
// the same provider that use one of those follow; gateway keys stay per model.
func (p *agentPickerState) cycleSource() {
	row := &p.rows[p.cursor]
	if len(row.sources) < 2 {
		return
	}
	row.source = (row.source + 1) % len(row.sources)
	chosen := row.sources[row.source]
	if !chosen.native() {
		return
	}
	for i := range p.rows {
		other := &p.rows[i]
		if i == p.cursor || len(other.sources) == 0 || other.sources[other.source].modelProvider != chosen.modelProvider || !other.sources[other.source].native() {
			continue
		}
		if index := slices.IndexFunc(other.sources, func(source agentModelSource) bool {
			return source.kind == chosen.kind && source.provider == chosen.provider
		}); index >= 0 {
			other.source = index
		}
	}
}

func (p *agentPickerState) handleKey(key string) (done, canceled bool) {
	if p.editing {
		return p.handleLevelKey(key)
	}
	row := &p.rows[p.cursor]
	switch key {
	case "up", "k":
		p.cursor = (p.cursor - 1 + len(p.rows)) % len(p.rows)
	case "down", "j":
		p.cursor = (p.cursor + 1) % len(p.rows)
	case " ":
		row.selected = !row.selected
	case "s":
		p.cycleSource()
	case "right", "l":
		if len(row.levelOpts) > 0 {
			p.editing = true
			p.levelCursor = firstCheckedIndex(row)
		}
	case "enter":
		if p.selectedCount() == 0 {
			return false, false
		}
		return true, false
	case "quit", "esc":
		return false, true
	}
	return false, false
}

func (p *agentPickerState) handleLevelKey(key string) (done, canceled bool) {
	row := &p.rows[p.cursor]
	switch key {
	case "up", "k":
		p.levelCursor = (p.levelCursor - 1 + len(row.levelOpts)) % len(row.levelOpts)
	case "down", "j":
		p.levelCursor = (p.levelCursor + 1) % len(row.levelOpts)
	case " ":
		level := row.levelOpts[p.levelCursor]
		row.checked[level] = !row.checked[level]
	case "left", "h", "esc", "enter":
		p.exitEditing()
	case "quit":
		return false, true
	}
	return false, false
}

func firstCheckedIndex(row *agentPickerRow) int {
	for i, level := range row.levelOpts {
		if row.checked[level] {
			return i
		}
	}
	return 0
}

func (p *agentPickerState) exitEditing() {
	row := &p.rows[p.cursor]
	if len(row.checkedLevels()) == 0 {
		row.checked = map[string]bool{}
		for _, level := range defaultLevelsFor(row.model, nil, row.recommendedLevels()) {
			row.checked[level] = true
		}
	}
	p.editing = false
}

func modelIDs(models []agentModel) []string {
	ids := make([]string, len(models))
	for i, model := range models {
		ids[i] = model.ID
	}
	return ids
}

func choiceIDs(choices []agentModelChoice) []string {
	ids := make([]string, len(choices))
	for i, choice := range choices {
		ids[i] = choice.ID
	}
	return ids
}

func choiceLevels(choices []agentModelChoice) map[string][]string {
	levels := make(map[string][]string, len(choices))
	for _, choice := range choices {
		levels[choice.ID] = append([]string(nil), choice.Levels...)
	}
	return levels
}

func agentProvidersFor(models []agentModel, ids []string) map[string]string {
	byID := make(map[string]agentModel, len(models))
	for _, model := range models {
		byID[model.ID] = model
	}
	providers := make(map[string]string, len(ids))
	for _, id := range ids {
		provider := byID[id].DefaultProvider
		if provider == "" {
			provider = byID[id].Provider
		}
		providers[id] = provider
	}
	return providers
}

func agentRouterNeedsUpdate(current agentRouter, choices []agentModelChoice) bool {
	if !sameStringSet(choiceIDs(choices), current.EnabledModels) {
		return true
	}
	for _, choice := range choices {
		if !sameStringSet(choice.Levels, current.ModelThinkingLevels[choice.ID]) {
			return true
		}
	}
	return false
}

func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := make(map[string]int, len(a))
	for _, value := range a {
		counts[value]++
	}
	for _, value := range b {
		if counts[value] == 0 {
			return false
		}
		counts[value]--
	}
	return true
}

func agentRouterCreateBody(
	setup agentSetup,
	models []agentModel,
	choices []agentModelChoice,
	subscribed []agentSubscriptionProvider,
) agentRouterCreateRequest {
	ids := choiceIDs(choices)
	providers := agentProvidersFor(models, ids)
	providerSources := map[string]string{}
	for _, provider := range providers {
		providerSources[provider] = "managed"
	}
	clientKey, name := setup.ownRouter(len(subscribed) > 0)
	subscriptionProviders := []string{}
	for _, subscription := range subscribed {
		if providerSources[subscription.routerProvider] != "" {
			subscriptionProviders = append(subscriptionProviders, subscription.routerProvider)
		}
	}
	return agentRouterCreateRequest{
		Name:                          name,
		ClientKey:                     clientKey,
		EnabledModels:                 ids,
		ModelProviders:                providers,
		ProviderKeySources:            providerSources,
		ModelThinkingLevels:           choiceLevels(choices),
		RoutingStrategy:               "dari",
		SpeculativeRouting:            true,
		PrimaryRetries:                3,
		SubscriptionProviders:         subscriptionProviders,
		SubscriptionAPIFallbackModels: []string{},
		EvalScoreImputation:           true,
	}
}

func agentRouterUpdateBody(
	current agentRouter,
	models []agentModel,
	choices []agentModelChoice,
) agentRouterUpdateRequest {
	ids := choiceIDs(choices)
	providers := agentProvidersFor(models, ids)
	currentProviders := map[string]bool{}
	for model, provider := range current.ModelProviders {
		currentProviders[provider] = true
		if slices.Contains(ids, model) {
			providers[model] = provider
		}
	}
	providerSources := map[string]string{}
	for _, provider := range providers {
		if !currentProviders[provider] {
			providerSources[provider] = "managed"
		}
	}
	return agentRouterUpdateRequest{
		Name:                current.Name,
		EnabledModels:       ids,
		ModelProviders:      providers,
		ProviderKeySources:  providerSources,
		ModelThinkingLevels: choiceLevels(choices),
		SessionPinning:      current.SessionPinning,
	}
}

// agentModelSuggestion is one recommended model set from the backend — the
// same list the frontend suggestion picker shows.
type agentModelSuggestion struct {
	modelIDs []string
	levels   map[string][]string
}

// fetchAgentModelSuggestion returns the named suggestion from the shared
// backend config so the CLI never hardcodes its own recommendations.
func fetchAgentModelSuggestion(
	ctx context.Context,
	client *api.Client,
	suggestionID string,
) (agentModelSuggestion, error) {
	var payload struct {
		Suggestions []struct {
			ID       string              `json:"id"`
			ModelIDs []string            `json:"model_ids"`
			Models   map[string][]string `json:"models"`
		} `json:"suggestions"`
	}
	if err := client.Do(
		ctx,
		http.MethodGet,
		"/v1/organizations/current/routers/model-suggestions",
		nil,
		&payload,
	); err != nil {
		return agentModelSuggestion{}, api.HumanError(err)
	}
	for _, suggestion := range payload.Suggestions {
		if suggestion.ID != suggestionID {
			continue
		}
		modelIDs := append([]string(nil), suggestion.ModelIDs...)
		if len(modelIDs) == 0 {
			modelIDs = make([]string, 0, len(suggestion.Models))
			for modelID := range suggestion.Models {
				modelIDs = append(modelIDs, modelID)
			}
			sort.Strings(modelIDs)
		}
		return agentModelSuggestion{
			modelIDs: modelIDs,
			levels:   suggestion.Models,
		}, nil
	}
	return agentModelSuggestion{}, fmt.Errorf(
		"no %q model suggestion is configured on the backend", suggestionID,
	)
}

// chooseAgentSessionPinning asks whether the router keeps one model for each
// session. Without a terminal it asks nothing and keeps current, so scripts
// leave the router's routing mode as it is.
func chooseAgentSessionPinning(stdin io.Reader, stderr io.Writer, current bool) (bool, error) {
	if !agentInputIsTerminal(stdin) {
		return current, nil
	}
	choice, err := runAgentChoiceTUI(stdin, stderr, "When should Dari pick the model?", nil, []agentChoiceOption{
		{label: "Every turn (default)", description: "Dari picks the best model for each request.", done: "Routing every turn"},
		{label: "Once per session", description: "Dari picks when a session starts and keeps that model. Each subagent gets its own pick, then keeps it.", done: "Routing once per session"},
	})
	if err != nil {
		return false, err
	}
	return choice == 1, nil
}
