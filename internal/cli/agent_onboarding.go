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
	"time"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/gateway"
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
	// codingAgent identifies the agent in the organization's router
	// assignments.
	codingAgent string
}

// agentSetups are the agents dari sets up, by launcher name.
var agentSetups = map[string]agentSetup{
	"claude":   {label: "Claude Code", suggestion: "claude", subscriptions: []agentSubscriptionProvider{claudeSubscription, codexSubscription}, routerKey: "dari-cli:claude-code", codingAgent: "claude_code"},
	"codex":    {label: "Codex", suggestion: "codex", subscriptions: []agentSubscriptionProvider{codexSubscription}, routerKey: "dari-cli:codex", codingAgent: "codex"},
	"muse":     {label: "Muse Code", suggestion: "muse", subscriptions: []agentSubscriptionProvider{museSubscription}, routerKey: "dari-cli:muse-code", codingAgent: "muse_code"},
	"opencode": {label: "OpenCode", suggestion: "default", subscriptions: []agentSubscriptionProvider{codexSubscription}, codingAgent: "opencode"},
	"pi":       {label: "Pi", suggestion: "default", subscriptions: []agentSubscriptionProvider{codexSubscription}, codingAgent: "pi"},
	"openclaw": {label: "OpenClaw", suggestion: "default", subscriptions: []agentSubscriptionProvider{codexSubscription}, codingAgent: "openclaw"},
	"hermes":   {label: "Hermes Agent", suggestion: "default", subscriptions: []agentSubscriptionProvider{codexSubscription}, codingAgent: "hermes"},
}

// ownsRouter reports whether the agent sets up a router of its own.
func (setup agentSetup) ownsRouter() bool {
	return setup.routerKey != ""
}

// isOwnRouter reports whether router is one dari set up for this agent.
func (setup agentSetup) isOwnRouter(router agentRouter) bool {
	return setup.ownsRouter() &&
		(router.ClientKey == setup.routerKey || router.ClientKey == setup.routerKey+"-managed")
}

// assignedAgentRouter is the router the organization assigned to this agent,
// unless dari's own setup decides it: the agent's own routers keep following
// its subscriptions, and a shared agent on the default router keeps the
// default router's setup.
func (setup agentSetup) assignedAgentRouter(routers []agentRouter) (agentRouter, bool) {
	assigned, ok := findAgentRouter(routers, func(router agentRouter) bool {
		return slices.Contains(router.CodingAgents, setup.codingAgent)
	})
	if !ok || setup.isOwnRouter(assigned) || (assigned.IsDefault && !setup.ownsRouter()) {
		return agentRouter{}, false
	}
	return assigned, true
}

// assignAgentRouter moves a coding agent onto a router.
func assignAgentRouter(ctx context.Context, client *api.Client, routerID, codingAgent string) error {
	path := "/v1/organizations/current/routers/" + url.PathEscape(routerID) + "/coding-agents/" + url.PathEscape(codingAgent)
	if err := client.Do(ctx, http.MethodPut, path, nil, nil); err != nil {
		return api.HumanError(err)
	}
	return nil
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
	// keysAdded counts the API keys connected on the Accounts page.
	keysAdded int
}

type agentRouter struct {
	ID                  string              `json:"id"`
	Name                string              `json:"name"`
	ClientKey           string              `json:"client_key"`
	IsDefault           bool                `json:"is_default"`
	CodingAgents        []string            `json:"coding_agents"`
	EnabledModels       []string            `json:"enabled_models"`
	ModelProviders      map[string]string   `json:"model_providers"`
	ModelThinkingLevels map[string][]string `json:"model_thinking_levels"`
	// ModelSources lists, per enabled model, where it is served from in
	// order: "plan" (the user's subscriptions), "reset" (a banked reset),
	// "key" (the router's saved key) and "managed" (Dari credits).
	ModelSources     map[string][]string `json:"model_sources"`
	SessionPinning   bool                `json:"session_pinning"`
	NativeCompaction bool                `json:"native_compaction"`
	// RoleModels pins a model to the main agent or subagents.
	RoleModels map[string]*string `json:"role_models"`
}

// planProviders are the providers serving any of the router's models from a
// plan.
func (router agentRouter) planProviders() []string {
	providers := []string{}
	for model, sources := range router.ModelSources {
		if provider := router.ModelProviders[model]; slices.Contains(sources, "plan") && provider != "" && !slices.Contains(providers, provider) {
			providers = append(providers, provider)
		}
	}
	return providers
}

// roleOf names the agent role a router pins model to, if any.
func (router agentRouter) roleOf(model string) string {
	var roles []string
	for _, role := range []struct{ key, name string }{{"main", "your main agent"}, {"subagent", "your subagents"}} {
		if pinned := router.RoleModels[role.key]; pinned != nil && *pinned == model {
			roles = append(roles, role.name)
		}
	}
	return strings.Join(roles, " and ")
}

type agentModel struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	// Maker is who made the model, which the picker groups by; Provider is
	// who serves it.
	Maker                string   `json:"maker"`
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
	Name                  string              `json:"name"`
	ClientKey             string              `json:"client_key"`
	CodingAgent           string              `json:"coding_agent"`
	EnabledModels         []string            `json:"enabled_models"`
	ModelProviders        map[string]string   `json:"model_providers"`
	ProviderCredentialIDs map[string]string   `json:"provider_credential_ids,omitempty"`
	ModelThinkingLevels   map[string][]string `json:"model_thinking_levels"`
	RoutingStrategy       string              `json:"routing_strategy"`
	SpeculativeRouting    bool                `json:"speculative_routing"`
	SessionPinning        bool                `json:"session_pinning"`
	PrimaryRetries        int                 `json:"primary_retries"`
	ModelSources          map[string][]string `json:"model_sources"`
	EvalScoreImputation   bool                `json:"eval_score_imputation"`
}

type agentRouterUpdateRequest struct {
	Name                  string              `json:"name"`
	EnabledModels         []string            `json:"enabled_models"`
	ModelProviders        map[string]string   `json:"model_providers"`
	ProviderCredentialIDs map[string]string   `json:"provider_credential_ids,omitempty"`
	ModelThinkingLevels   map[string][]string `json:"model_thinking_levels"`
	// Each enabled model's sources; nil is omitted and keeps the router's.
	ModelSources     map[string][]string `json:"model_sources,omitempty"`
	SessionPinning   bool                `json:"session_pinning"`
	NativeCompaction bool                `json:"native_compaction"`
}

type agentRouterSubscriptionUpdateRequest struct {
	Name                string              `json:"name"`
	EnabledModels       []string            `json:"enabled_models"`
	ModelProviders      map[string]string   `json:"model_providers,omitempty"`
	ModelThinkingLevels map[string][]string `json:"model_thinking_levels,omitempty"`
	ModelSources        map[string][]string `json:"model_sources"`
}

type agentCredential struct {
	OAuthProvider string `json:"oauth_provider"`
}

// How long, and how often, a device-code approval is awaited when no one is
// at the terminal to say it is done.
var (
	agentApprovalWait = 10 * time.Minute
	agentApprovalPoll = 3 * time.Second
)

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
	reconfigure bool,
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
	// `dari setup <agent>` opens the picker on the router the agent uses.
	if reconfigure && agentInputIsTerminal(stdin) {
		target, found := findAgentRouter(routers, func(router agentRouter) bool {
			return slices.Contains(router.CodingAgents, setup.codingAgent)
		})
		if !found && !setup.ownsRouter() {
			target, found = defaultRouter, true
		}
		if found {
			return target.ID, reconfigureAgentRouter(ctx, client, setup, target, stdin, stderr)
		}
	}
	if assigned, ok := setup.assignedAgentRouter(routers); ok {
		return configured(assigned.ID)
	}
	// The agent's own router, once chosen, is the one it is assigned.
	ownRouter := func(router agentRouter) (string, error) {
		if !slices.Contains(router.CodingAgents, setup.codingAgent) {
			if err := assignAgentRouter(ctx, client, router.ID, setup.codingAgent); err != nil {
				return "", err
			}
		}
		return configured(router.ID)
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
				return ownRouter(existing)
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
			return ownRouter(existing)
		}
	}

	title := "Choose Models for " + setup.label
	suggestion, err := fetchAgentModelSuggestion(ctx, client, setup.suggestion)
	if err != nil {
		return "", err
	}
	models, err := listAgentModels(ctx, client)
	if err != nil {
		return "", err
	}
	if !setup.ownsRouter() {
		models = includeCurrentAgentModels(models, defaultRouter)
	}
	// Each model offers the subscriptions, keys, and credits that can pay for
	// it, preferred first; the picker lets the user change any of them.
	if !setup.ownsRouter() {
		subscribed = slices.DeleteFunc(slices.Clone(setup.subscriptions), func(subscription agentSubscriptionProvider) bool {
			return !slices.Contains(defaultRouter.planProviders(), subscription.routerProvider)
		})
	}
	keyContext, err := loadAgentKeyContext(ctx, client, subscribed)
	if err != nil {
		return "", err
	}
	// Recommended models are green in the picker, and checked in the
	// numbered list a script gets.
	intro := "Checked models are recommended."
	if agentInputIsTerminal(stdin) {
		intro = "Green is recommended."
	}
	pinningDefault := false
	if !setup.ownsRouter() {
		pinningDefault = defaultRouter.SessionPinning
	}
	modelProviders := agentProvidersFor(models, modelIDs(models))
	picked, err := pickAgentModels(ctx, client, stdin, stderr, agentModelPickInput{
		title:             title,
		intro:             intro,
		models:            models,
		defaultIDs:        suggestion.modelIDs,
		recommendedLevels: suggestion.levels,
		keyContext:        keyContext,
		modelProviders:    modelProviders,
		askPinning:        true,
		pinningDefault:    pinningDefault,
	})
	if err != nil {
		return "", err
	}
	choices, sessionPinning := picked.choices, picked.sessionPinning
	choices = keyContext.withSources(models, choices, modelProviders)
	agentStep(stderr, "Paying with "+agentSourceSummary(models, choices))
	keys := keyContext.keys(choices)
	routerID := defaultRouter.ID
	if !setup.ownsRouter() {
		body := agentRouterUpdateBody(defaultRouter, models, choices)
		keys.apply(body.ModelProviders)
		body.ProviderCredentialIDs = keys.credentialIDs
		body.SessionPinning = sessionPinning
		body.ModelSources = keys.modelSources(defaultRouter, body.EnabledModels, body.ModelProviders)
		if len(keys.credentialIDs) > 0 || body.SessionPinning != defaultRouter.SessionPinning || agentRouterNeedsUpdate(defaultRouter, choices) ||
			!maps.EqualFunc(body.ModelSources, defaultRouter.ModelSources, slices.Equal) {
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
		keys.apply(body.ModelProviders)
		body.ProviderCredentialIDs = keys.credentialIDs
		body.ModelSources = keys.modelSources(agentRouter{}, body.EnabledModels, body.ModelProviders)
		body.SessionPinning = sessionPinning
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

// reconfigureAgentRouter opens the models picker on a router the agent
// already uses, starting from its models, and saves what is chosen.
func reconfigureAgentRouter(ctx context.Context, client *api.Client, setup agentSetup, router agentRouter, stdin io.Reader, stderr io.Writer) error {
	models, err := listAgentModels(ctx, client)
	if err != nil {
		return err
	}
	models = includeCurrentAgentModels(models, router)
	// Setup asks how to pay: the Accounts page connects subscriptions and
	// keys, and every connected subscription is offered in the picker.
	if _, err := (accountsPage{client: client, providers: setup.subscriptions, hosted: true, onboarding: true}).run(ctx, stdin, stderr); err != nil && !errors.Is(err, errAgentChoiceCanceled) {
		return err
	}
	subscribed, err := connectedAgentSubscriptions(ctx, client, setup.subscriptions)
	if err != nil {
		return err
	}
	keyContext, err := loadAgentKeyContext(ctx, client, subscribed)
	if err != nil {
		return err
	}
	suggestion, err := fetchAgentModelSuggestion(ctx, client, setup.suggestion)
	if err != nil {
		return err
	}
	modelProviders := agentProvidersFor(models, modelIDs(models))
	maps.Copy(modelProviders, router.ModelProviders)
	picked, err := pickAgentModels(ctx, client, stdin, stderr, agentModelPickInput{
		title:             "Choose Models for " + setup.label,
		intro:             "Checked models are in use.",
		models:            models,
		defaultIDs:        router.EnabledModels,
		currentLevels:     router.ModelThinkingLevels,
		recommendedLevels: suggestion.levels,
		keyContext:        keyContext,
		modelProviders:    modelProviders,
		askPinning:        true,
		pinningDefault:    router.SessionPinning,
	})
	if err != nil {
		return err
	}
	choices := keyContext.withSources(models, picked.choices, modelProviders)
	agentStep(stderr, "Paying with "+agentSourceSummary(models, choices))
	keys := keyContext.keys(choices)
	body := agentRouterUpdateBody(router, models, choices)
	keys.apply(body.ModelProviders)
	body.ProviderCredentialIDs = keys.credentialIDs
	body.SessionPinning = picked.sessionPinning
	body.ModelSources = keys.modelSources(router, body.EnabledModels, body.ModelProviders)
	if _, err := putAgentRouter(ctx, client, router.ID, body); err != nil {
		return err
	}
	agentStep(stderr, router.Name+" updated")
	return nil
}

// agentModelPickInput is what the models picker starts from.
type agentModelPickInput struct {
	title string
	// intro is the picker's first note line.
	intro  string
	models []agentModel
	// defaultIDs are the models checked when the picker opens.
	defaultIDs        []string
	currentLevels     map[string][]string
	recommendedLevels map[string][]string
	keyContext        agentKeyContext
	modelProviders    map[string]string
	// askPinning asks whether Dari picks per turn or per session; without it
	// the pick keeps pinningDefault.
	askPinning     bool
	pinningDefault bool
}

// agentModelPick is what the models picker chose.
type agentModelPick struct {
	choices        []agentModelChoice
	sessionPinning bool
}

// pickAgentModels runs the models picker, then session pinning when asked,
// until the user finishes. Esc on the second page comes back to the models as
// they were chosen; Esc on the models asks before leaving setup.
func pickAgentModels(
	ctx context.Context,
	client *api.Client,
	stdin io.Reader,
	stderr io.Writer,
	in agentModelPickInput,
) (agentModelPick, error) {
	sources := map[string][]agentModelSource{}
	for _, model := range in.models {
		sources[model.ID] = in.keyContext.sources(model, in.modelProviders[model.ID])
	}
	defaultIDs, currentLevels := in.defaultIDs, in.currentLevels
	pick := agentModelPick{sessionPinning: in.pinningDefault}
	for {
		routing, err := autoroutingAllowed(ctx, client)
		if err != nil {
			return agentModelPick{}, err
		}
		note := []string{in.intro + " Dari picks among the checked models."}
		if !routing {
			offer := "`dari accounts` for auto-routing ($20/mo)."
			if agentInputIsTerminal(stdin) {
				offer = "Press a for auto-routing ($20/mo)."
			}
			note = []string{in.intro + " Switch with /model.", offer}
		}
		pick.choices, err = selectAgentModels(stdin, stderr, in.title, note, !routing, in.models, defaultIDs, currentLevels, in.recommendedLevels, sources)
		if errors.Is(err, errAgentWantsAutorouting) {
			// Esc on the auto-routing page comes back to the models.
			if _, err := getAutorouting(ctx, client, stdin, stderr); err != nil && !errors.Is(err, errAgentChoiceCanceled) {
				return agentModelPick{}, err
			}
			continue
		}
		if errors.Is(err, errAgentChoiceCanceled) {
			leave, err := runAgentChoiceTUI(stdin, stderr, "Leave Setup?", []string{"Nothing is saved yet."}, []agentChoiceOption{{label: "Keep Choosing"}, {label: "Leave Setup"}})
			if (err == nil && leave == 0) || errors.Is(err, errAgentChoiceCanceled) {
				continue
			}
			if err == nil {
				err = errAgentQuit
			}
			return agentModelPick{}, err
		}
		if err != nil {
			return agentModelPick{}, err
		}
		if !in.askPinning {
			return pick, nil
		}
		pick.sessionPinning, err = chooseAgentSessionPinning(stdin, stderr, in.pinningDefault)
		if errors.Is(err, errAgentChoiceCanceled) {
			// Back to the models, as they were just chosen, which are no
			// longer settled.
			dropAgentStep("Models: ")
			defaultIDs, currentLevels = nil, map[string][]string{}
			for _, choice := range pick.choices {
				defaultIDs = append(defaultIDs, choice.ID)
				currentLevels[choice.ID] = choice.Levels
			}
			continue
		}
		if err != nil {
			return agentModelPick{}, err
		}
		return pick, nil
	}
}

// connectedAgentSubscriptions are the providers whose personal subscription
// the user has connected.
func connectedAgentSubscriptions(ctx context.Context, client *api.Client, providers []agentSubscriptionProvider) ([]agentSubscriptionProvider, error) {
	var listed agentSubscriptionStatus
	if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials", nil, &listed); err != nil {
		return nil, api.HumanError(err)
	}
	// A plan on this computer's gateway is connected too.
	gatewayID := ""
	if settings, ok, _ := gateway.Load(); ok {
		gatewayID = settings.GatewayID
	}
	return slices.DeleteFunc(slices.Clone(providers), func(provider agentSubscriptionProvider) bool {
		return !slices.ContainsFunc(listed.Credentials, func(credential agentCredential) bool {
			return credential.OAuthProvider == provider.id
		}) && !slices.ContainsFunc(listed.LocalSubscriptions, func(local localSubscription) bool {
			return gatewayID != "" && local.GatewayID == gatewayID && local.Provider == provider.id
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
		result, err := accountsPage{client: client, providers: providers, hosted: true, onboarding: true}.run(ctx, stdin, stderr)
		keysAdded := result.keysAdded
		if len(result.added) == 0 {
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
	_, err := connectSubscription(ctx, provider, client, stdin, stderr, credentialName, false, "", provider.name+" subscription connected")
	return err
}

// connectSubscription is connectAgentPersonalSubscription on a client that
// may be a local gateway: private keeps the plan off hosted Dari there,
// movingFrom names the plan a move replaces (as the client's side knows it),
// and done, when set, is the line printed once it is connected. It returns
// the plan the sign-in connected.
func connectSubscription(
	ctx context.Context,
	provider agentSubscriptionProvider,
	client *api.Client,
	stdin io.Reader,
	stderr io.Writer,
	credentialName string,
	private bool,
	movingFrom string,
	done string,
) (subscriptionCredential, error) {
	body := map[string]any{"provider": provider.id}
	if credentialName != "" {
		body["credential_name"] = credentialName
	}
	if private {
		body["private"] = true
	}
	// The plan being moved still holds the account until the move disconnects
	// it; naming it keeps the sign-in from being refused as a second copy.
	if movingFrom != "" {
		body["moving_from"] = movingFrom
	}
	var started agentSubscriptionOAuthStart
	if err := client.Do(
		ctx,
		http.MethodPost,
		"/v1/organizations/current/credentials/oauth/sessions",
		body,
		&started,
	); err != nil {
		return subscriptionCredential{}, api.HumanError(err)
	}
	if strings.TrimSpace(started.SessionToken) == "" || strings.TrimSpace(started.AuthorizationURL) == "" {
		return subscriptionCredential{}, fmt.Errorf("Dari returned an incomplete %s authorization session", provider.name)
	}

	if provider.deviceCode {
		if strings.TrimSpace(started.UserCode) == "" {
			return subscriptionCredential{}, fmt.Errorf("Dari returned a %s authorization session without a device code", provider.name)
		}
		return connectAgentDeviceCodeSubscription(ctx, provider, client, stdin, stderr, started, done)
	}

	opened := openAgentBrowser(started.AuthorizationURL)
	if agentInputIsTerminal(stdin) {
		authorizationResponse, err := runAgentCodeInputTUI(provider, stdin, stderr, started.AuthorizationURL, opened)
		if err != nil {
			return subscriptionCredential{}, err
		}
		return completeAgentPersonalSubscription(ctx, provider, client, stderr, started.SessionToken, authorizationResponse, done)
	}

	writeAgentOAuthInstructions(provider, stderr, started.AuthorizationURL, opened)
	if provider.pastedKey {
		fmt.Fprintf(stderr, "Paste your %s key: ", provider.name)
	} else {
		fmt.Fprintf(stderr, "After approving, paste the authorization code %s shows: ", provider.vendor)
	}
	authorizationResponse, err := readAgentLine(stdin)
	if err != nil {
		return subscriptionCredential{}, fmt.Errorf("read %s authorization code: %w", provider.name, err)
	}
	return completeAgentPersonalSubscription(ctx, provider, client, stderr, started.SessionToken, authorizationResponse, done)
}

func connectAgentDeviceCodeSubscription(
	ctx context.Context,
	provider agentSubscriptionProvider,
	client *api.Client,
	stdin io.Reader,
	stderr io.Writer,
	started agentSubscriptionOAuthStart,
	done string,
) (subscriptionCredential, error) {
	opened := openAgentBrowser(started.AuthorizationURL)
	var connected subscriptionCredential
	complete := func() error {
		var err error
		connected, err = completeAgentPersonalSubscription(ctx, provider, client, stderr, started.SessionToken, "", done)
		return err
	}
	pending := func(err error) bool {
		return err != nil && strings.HasPrefix(err.Error(), provider.vendor+" approval is still pending.")
	}
	if agentInputIsTerminal(stdin) {
		err := runAgentDeviceCodeTUI(provider, stdin, stderr, started.AuthorizationURL, started.UserCode, opened, func() (bool, error) {
			// The result is reported after the prompt is erased.
			var err error
			connected, err = completeAgentPersonalSubscriptionQuietly(ctx, client, started.SessionToken, "")
			return pending(err), err
		})
		if err != nil {
			return connected, err
		}
		if done != "" {
			agentStep(stderr, done)
		}
		return connected, nil
	}
	writeAgentOAuthInstructions(provider, stderr, started.AuthorizationURL, opened)
	fmt.Fprintf(stderr, "Enter this code at %s: %s\n", provider.vendor, started.UserCode)
	for {
		fmt.Fprintln(stderr, "After approving access, press Enter here to finish connecting.")
		if _, err := readAgentLine(stdin); err != nil {
			if !errors.Is(err, io.EOF) {
				return connected, fmt.Errorf("read %s approval: %w", provider.name, err)
			}
			// No one is here to press Enter (an agent or a script): wait for
			// the approval instead.
			fmt.Fprintf(stderr, "Waiting for the approval at %s (up to %s).\n", provider.vendor, agentApprovalWait)
			deadline := time.Now().Add(agentApprovalWait)
			for {
				err := complete()
				if !pending(err) {
					return connected, err
				}
				if time.Now().After(deadline) {
					return connected, fmt.Errorf("%s approval did not arrive in %s; run the command again", provider.vendor, agentApprovalWait)
				}
				select {
				case <-ctx.Done():
					return connected, ctx.Err()
				case <-time.After(agentApprovalPoll):
				}
			}
		}
		err := complete()
		if pending(err) {
			fmt.Fprintln(stderr, err)
			continue
		}
		return connected, err
	}
}

func completeAgentPersonalSubscription(
	ctx context.Context,
	provider agentSubscriptionProvider,
	client *api.Client,
	stderr io.Writer,
	sessionToken string,
	authorizationResponse string,
	done string,
) (subscriptionCredential, error) {
	if strings.TrimSpace(authorizationResponse) == "" && !provider.deviceCode {
		return subscriptionCredential{}, fmt.Errorf("%s authorization was not completed", provider.name)
	}
	connected, err := completeAgentPersonalSubscriptionQuietly(ctx, client, sessionToken, authorizationResponse)
	if err != nil {
		return connected, err
	}
	if done != "" {
		agentStep(stderr, done)
	}
	return connected, nil
}

func completeAgentPersonalSubscriptionQuietly(ctx context.Context, client *api.Client, sessionToken, authorizationResponse string) (subscriptionCredential, error) {
	var connected subscriptionCredential
	if err := client.Do(
		ctx,
		http.MethodPost,
		"/v1/organizations/current/credentials/oauth/sessions/complete",
		map[string]string{
			"session_token":          sessionToken,
			"authorization_response": authorizationResponse,
		},
		&connected,
	); err != nil {
		return connected, api.HumanError(err)
	}
	return connected, nil
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

// setAgentRouterSubscription puts the subscriptions' plans first for, or takes
// them off, the router's models those plans' providers serve. A model taken
// off its plan runs on its key or Dari credits.
func setAgentRouterSubscription(
	ctx context.Context,
	client *api.Client,
	router agentRouter,
	subscriptions []agentSubscriptionProvider,
	enabled bool,
) error {
	sources := map[string][]string{}
	changed := false
	for _, model := range router.EnabledModels {
		current := router.ModelSources[model]
		next := current
		if slices.ContainsFunc(subscriptions, func(s agentSubscriptionProvider) bool { return s.routerProvider == router.ModelProviders[model] }) {
			if enabled && !slices.Contains(current, "plan") {
				next = []string{"plan"}
			} else if !enabled && slices.Contains(current, "plan") {
				// Off its plan, a model keeps its key or Dari credits, else
				// moves to Dari credits.
				next = slices.DeleteFunc(slices.Clone(current), func(source string) bool { return source == "plan" || source == "reset" })
				if len(next) == 0 {
					next = []string{"managed"}
				}
			}
		}
		changed = changed || !slices.Equal(next, current)
		sources[model] = next
	}
	if !changed {
		return nil
	}
	if strings.TrimSpace(router.Name) == "" || len(router.EnabledModels) == 0 {
		return errors.New("Dari returned an incomplete agent router")
	}
	body := agentRouterSubscriptionUpdateRequest{
		Name:                router.Name,
		EnabledModels:       router.EnabledModels,
		ModelProviders:      router.ModelProviders,
		ModelThinkingLevels: router.ModelThinkingLevels,
		ModelSources:        sources,
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
	// note shows under the model on the payment page, such as the role a
	// template pins it to.
	note string
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
	rows []agentPickerRow
	// cursor indexes items(): the models, an open model's thinking levels
	// and payment, then Continue.
	cursor int
	// open is the model whose thinking levels and payment show beneath it,
	// or -1.
	open int
	// warning shows by Continue when there is nothing to continue with.
	warning string
	// paying is the second page: how each chosen model is paid for.
	paying bool
	// quit is set when the picker was left with q or ctrl+c, which leaves the
	// command, rather than with esc, which goes back.
	quit bool
	// fixed is a template's picker: its models can't change, so it opens on
	// the payment page, shows every model there, and esc leaves.
	fixed bool
	// action is the row whose connect or add-key choice enter picked, or -1.
	action int
	// width is the page's width, which the payment page wraps its choices
	// to; 0 is no limit.
	width int
}

// agentPickerItem is one line the cursor can rest on.
type agentPickerItem struct {
	kind  string // "model", "level", "source", or "continue"
	row   int
	index int
}

func (p *agentPickerState) items() []agentPickerItem {
	items := []agentPickerItem{}
	for i, row := range p.rows {
		if p.paying {
			// A template's page reaches every model, so one whose only way to
			// pay is a setup step can still run it.
			if row.selected && (len(row.sources) > 1 || p.fixed) {
				items = append(items, agentPickerItem{kind: "source", row: i})
			}
			continue
		}
		items = append(items, agentPickerItem{kind: "model", row: i})
		if i != p.open {
			continue
		}
		for j := range row.levelOpts {
			items = append(items, agentPickerItem{kind: "level", row: i, index: j})
		}
	}
	return append(items, agentPickerItem{kind: "continue", row: -1})
}

// needsPaying reports whether a chosen model can be paid for more than one way.
func (p *agentPickerState) needsPaying() bool {
	return slices.ContainsFunc(p.rows, func(row agentPickerRow) bool { return row.selected && len(row.sources) > 1 })
}

// cursorOn moves the cursor to row's model line.
func (p *agentPickerState) cursorOn(row int) {
	p.cursor = slices.IndexFunc(p.items(), func(item agentPickerItem) bool { return item.kind == "model" && item.row == row })
}

// openRow shows a model's thinking levels and payment beneath it.
func (p *agentPickerState) openRow(row int) {
	p.closeRow()
	p.open = row
	p.cursorOn(row)
}

// closeRow hides the open model's details, giving it its default levels
// back if none were left checked.
func (p *agentPickerState) closeRow() {
	if p.open < 0 {
		return
	}
	row := &p.rows[p.open]
	if len(row.levelOpts) > 0 && len(row.checkedLevels()) == 0 {
		row.checked = map[string]bool{}
		for _, level := range defaultLevelsFor(row.model, nil, row.recommendedLevels()) {
			row.checked[level] = true
		}
	}
	closed := p.open
	p.open = -1
	p.cursorOn(closed)
}

func newAgentPickerState(
	models []agentModel,
	defaults []string,
	currentLevels map[string][]string,
	recommendedLevels map[string][]string,
	sources map[string][]agentModelSource,
) *agentPickerState {
	state := &agentPickerState{rows: make([]agentPickerRow, 0, len(models)), open: -1, action: -1}
	for _, model := range models {
		row := newAgentPickerRow(model, currentLevels[model.ID], recommendedLevels[model.ID])
		row.selected = slices.Contains(defaults, model.ID)
		row.sources = sources[model.ID]
		state.rows = append(state.rows, row)
	}
	// Models are shown under their maker, makers in the order they first
	// appear.
	order := []string{}
	for _, row := range state.rows {
		if maker := agentModelMaker(row.model); !slices.Contains(order, maker) {
			order = append(order, maker)
		}
	}
	slices.SortStableFunc(state.rows, func(a, b agentPickerRow) int {
		return slices.Index(order, agentModelMaker(a.model)) - slices.Index(order, agentModelMaker(b.model))
	})
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

// handleKey moves the cursor or acts on the line under it. On the first
// page enter chooses a model or a thinking level, → opens a model's levels
// and ← closes them; on the second, ← → choose how a model is paid for.
// Continue on the first page goes on to the second when a chosen model can
// be paid for more than one way, and finishes otherwise.
func (p *agentPickerState) handleKey(key string) (done, canceled bool) {
	items := p.items()
	p.cursor = min(max(p.cursor, 0), len(items)-1)
	item := items[p.cursor]
	switch key {
	case "up", "k":
		p.cursor = max(p.cursor-1, 0)
	case "down", "j":
		p.cursor = min(p.cursor+1, len(items)-1)
	case "right", "l", "left", "h":
		forward := key == "right" || key == "l"
		switch {
		case item.kind == "source":
			row := &p.rows[item.row]
			if forward {
				row.source = min(row.source+1, len(row.sources)-1)
			} else {
				row.source = max(row.source-1, 0)
			}
		case forward && item.kind == "model" && item.row != p.open && len(p.rows[item.row].levelOpts) > 1:
			p.openRow(item.row)
		case !forward:
			p.closeRow()
		}
	case "enter", " ":
		p.warning = ""
		switch item.kind {
		case "model":
			p.rows[item.row].selected = !p.rows[item.row].selected
		case "level":
			row := &p.rows[item.row]
			level := row.levelOpts[item.index]
			row.checked[level] = !row.checked[level]
		case "source":
			// Each model is paid for on its own, even within one provider.
			row := &p.rows[item.row]
			if row.sources[row.source].action() {
				p.action = item.row
				return true, false
			}
			row.source = (row.source + 1) % len(row.sources)
		case "continue":
			if p.selectedCount() == 0 {
				p.warning = "Choose at least one model."
				return false, false
			}
			for _, row := range p.rows {
				if row.selected && len(row.sources) > 0 && row.sources[row.source].action() {
					p.warning = row.model.DisplayName + ": press enter to " + row.sources[row.source].label + ", or choose another option."
					return false, false
				}
			}
			p.closeRow()
			if !p.paying && p.needsPaying() {
				p.paying, p.cursor = true, 0
				return false, false
			}
			return true, false
		}
	case "esc":
		switch {
		case p.open >= 0:
			p.closeRow()
		case p.paying && !p.fixed:
			p.paying, p.cursor = false, 0
		default:
			return false, true
		}
	case "quit":
		p.quit = true
		return false, true
	}
	return false, false
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
	clientKey, name := setup.ownRouter(len(subscribed) > 0)
	return agentRouterCreateRequest{
		Name:                name,
		ClientKey:           clientKey,
		CodingAgent:         setup.codingAgent,
		EnabledModels:       ids,
		ModelProviders:      providers,
		ModelThinkingLevels: choiceLevels(choices),
		RoutingStrategy:     "dari",
		SpeculativeRouting:  true,
		PrimaryRetries:      3,
		EvalScoreImputation: true,
	}
}

func agentRouterUpdateBody(
	current agentRouter,
	models []agentModel,
	choices []agentModelChoice,
) agentRouterUpdateRequest {
	ids := choiceIDs(choices)
	providers := agentProvidersFor(models, ids)
	for model, provider := range current.ModelProviders {
		if slices.Contains(ids, model) {
			providers[model] = provider
		}
	}
	return agentRouterUpdateRequest{
		Name:                current.Name,
		EnabledModels:       ids,
		ModelProviders:      providers,
		ModelThinkingLevels: choiceLevels(choices),
		SessionPinning:      current.SessionPinning,
		NativeCompaction:    current.NativeCompaction,
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
	choice, err := runAgentChoiceTUI(stdin, stderr, "Route", []string{
		"Dari can hold a model for a few turns (a lease) to keep its prompt cache warm.",
	}, []agentChoiceOption{
		{label: "Every Turn", description: "A pick for each request, holding a model with short leases", done: "Routing every turn"},
		{label: "Once per Session", description: "One pick per session and subagent", done: "Routing once per session"},
	})
	if err != nil {
		return false, err
	}
	return choice == 1, nil
}
