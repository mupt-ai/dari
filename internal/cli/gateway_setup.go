package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"sort"
	"strings"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/gateway"
	"github.com/mupt-ai/dari/internal/state"
)

// agentGateway returns the gateway a launch routes through, nil for the
// hosted Dari API. The first launch on a machine where nobody signed in asks
// where to route; machines already signed in stay hosted.
func agentGateway(ctx context.Context, stdin io.Reader, stderr io.Writer) (*gatewayConfig, error) {
	gw, err := currentGateway()
	if gw != nil || err != nil {
		return gw, err
	}
	if _, saved, err := gateway.Load(); saved || err != nil {
		return nil, err
	}
	if signedIn() || !agentInputIsTerminal(stdin) {
		return nil, nil
	}
	if err := runGatewaySetup(ctx, stdin, stderr); err != nil {
		return nil, err
	}
	return currentGateway()
}

// signedIn reports whether this machine already routes through the hosted
// Dari API: a browser sign-in, or a Dari key in the environment.
func signedIn() bool {
	if auth.EnvAPIKeyValue() != "" || strings.TrimSpace(os.Getenv("DARI_ROUTING_API_KEY")) != "" {
		return true
	}
	s, err := state.Load()
	return err == nil && s.CurrentOrg() != nil
}

const (
	gatewaySetupHosted = iota
	gatewaySetupLocal
	gatewaySetupSelfHosted
)

// runGatewaySetup asks where the coding agents route and saves the answer.
// saveGatewayMode saves a routing choice. The local gateway's secrets (its
// auto-routing and provider API keys) survive a switch to another mode, so
// coming back to Fully local keeps them. The local gateway stops on every
// switch: leaving local it would keep serving with its old credentials, and
// entering it a process with an older key would refuse the new one.
func saveGatewayMode(ctx context.Context, settings gateway.Settings) error {
	previous, _, err := gateway.Load()
	if err != nil {
		return err
	}
	// The local key outlives mode switches, so agents set up with it, such
	// as OpenClaw and Hermes, keep working after a round trip.
	settings.LocalKey = previous.LocalKey
	// A self-hosted gateway is remembered, so switching back is one choice.
	if settings.Mode != gateway.ModeSelfHosted {
		settings.URL, settings.Key = previous.URL, previous.Key
	}
	if settings.AutoRoutingKey == "" {
		settings.AutoRoutingKey = previous.AutoRoutingKey
	}
	if settings.ProviderKeys == nil {
		settings.ProviderKeys = previous.ProviderKeys
	}
	if settings.Mode == gateway.ModeLocal && settings.LocalKey == "" {
		if settings.LocalKey, err = gateway.NewKey(); err != nil {
			return err
		}
	}
	if err := gateway.Save(settings); err != nil {
		return err
	}
	_, err = gateway.Stop(ctx)
	return err
}

// switchGatewayMode saves a routing choice and brings the machine along:
// set-up agents move to it, and a gateway with nothing connected opens the
// Accounts page, since the accounts of the previous mode stay there.
func switchGatewayMode(ctx context.Context, settings gateway.Settings, stdin io.Reader, stderr io.Writer) error {
	if err := saveGatewayMode(ctx, settings); err != nil {
		return err
	}
	interactive := agentInputIsTerminal(stdin)
	if !interactive {
		// The menu prints its own choice.
		agentStep(stderr, gatewayModeDone[settings.Mode])
	}
	if gw, err := currentGateway(); interactive && err == nil && gw != nil {
		if err := gw.ensure(ctx, stderr); err != nil {
			return err
		}
		if _, err := routerModels(ctx, gw.url, gw.key, ""); errors.Is(err, errNoProviderCredentials) {
			agentStep(stderr, "This gateway has no accounts yet; accounts stay with the mode they were connected in")
			page := accountsPage{client: api.New(gw.url).WithBearer(gw.key), providers: allSubscriptionProviders, gw: gw}
			if _, err := page.run(ctx, stdin, stderr); err != nil {
				return err
			}
		}
	}
	moveAgentSetups(ctx, stdin, stderr)
	return nil
}

// gatewayModeDone is the line each mode prints once saved.
var gatewayModeDone = map[gateway.Mode]string{
	gateway.ModeHosted:     "Routing through hosted Dari",
	gateway.ModeLocal:      "Routing through a local gateway",
	gateway.ModeSelfHosted: "Routing through a self-hosted gateway",
}

// checkSelfHostedGateway confirms a self-hosted gateway accepts key.
func checkSelfHostedGateway(ctx context.Context, url, key string) error {
	if _, err := routerModels(ctx, url, key, ""); err != nil && !errors.Is(err, errNoProviderCredentials) {
		return fmt.Errorf("the gateway did not accept this key: %v", err)
	}
	return nil
}

// setGatewayModeFromFlags saves the routing choice named by --mode without a
// terminal, for scripts and agents. Flags stand in for the menu's answers.
func setGatewayModeFromFlags(ctx context.Context, mode, url, key, autoRoutingKey string, stdin io.Reader, stderr io.Writer) error {
	var settings gateway.Settings
	switch mode {
	case "hosted":
		settings = gateway.Settings{Mode: gateway.ModeHosted}
	case "local":
		settings = gateway.Settings{Mode: gateway.ModeLocal, AutoRoutingKey: autoRoutingKey}
	case "self-hosted":
		if url == "" || key == "" {
			return errors.New("--mode self-hosted needs --url and --key")
		}
		normalized, err := normalizeGatewayURL(url)
		if err != nil {
			return err
		}
		if err := checkSelfHostedGateway(ctx, normalized, key); err != nil {
			return err
		}
		settings = gateway.Settings{Mode: gateway.ModeSelfHosted, URL: normalized, Key: key}
	default:
		return fmt.Errorf("--mode must be hosted, local, or self-hosted, got %q", mode)
	}
	return switchGatewayMode(ctx, settings, stdin, stderr)
}

func runGatewaySetup(ctx context.Context, stdin io.Reader, stderr io.Writer) error {
	if !agentInputIsTerminal(stdin) {
		return errors.New("gateway setup needs an interactive terminal; use `dari gateway setup --mode hosted|local|self-hosted` instead")
	}
	choice, err := runAgentChoiceTUI(stdin, stderr, "Where should your coding agents route?", nil, []agentChoiceOption{
		gatewaySetupHosted: {
			label:       "Hosted",
			note:        "Recommended",
			description: "Dari runs the gateway. Share it with your team, see Activity analytics, and use Dari billing.",
			done:        gatewayModeDone[gateway.ModeHosted],
		},
		gatewaySetupLocal: {
			label:       "Fully local",
			description: "Runs on this machine; requests go straight to model providers. Only you can use it. No observability: Activity and analytics need Hosted.",
			done:        gatewayModeDone[gateway.ModeLocal],
		},
		gatewaySetupSelfHosted: {
			label:       "Self-hosted",
			description: "Connect to a Dari Gateway your team runs on its own server, so everyone shares its accounts and routing. No observability: Activity and analytics need Hosted.",
			done:        gatewayModeDone[gateway.ModeSelfHosted],
		},
	})
	if err != nil {
		return err
	}
	switch choice {
	case gatewaySetupHosted:
		return switchGatewayMode(ctx, gateway.Settings{Mode: gateway.ModeHosted}, stdin, stderr)
	case gatewaySetupLocal:
		settings := gateway.Settings{Mode: gateway.ModeLocal}
		if previous, _, _ := gateway.Load(); previous.AutoRoutingKey == "" {
			if settings.AutoRoutingKey, err = askAutoRoutingKey(stdin, stderr); err != nil {
				return err
			}
		}
		return switchGatewayMode(ctx, settings, stdin, stderr)
	default:
		settings := gateway.Settings{Mode: gateway.ModeSelfHosted}
		// The gateway used before needs no typing again.
		if previous, _, _ := gateway.Load(); previous.URL != "" && previous.Key != "" {
			reuse, err := runAgentChoiceTUI(stdin, stderr, "Self-hosted gateway", nil, []agentChoiceOption{
				{label: "Use " + previous.URL},
				{label: "Use another gateway"},
			})
			if err != nil {
				return err
			}
			if reuse == 0 {
				if err := checkSelfHostedGateway(ctx, previous.URL, previous.Key); err != nil {
					return err
				}
				settings.URL, settings.Key = previous.URL, previous.Key
				return switchGatewayMode(ctx, settings, stdin, stderr)
			}
		}
		if ok, err := runAgentTextInputTUI(stdin, stderr, "Gateway URL", []string{
			"  The URL your team's Dari Gateway serves on, such as https://gateway.example.com.",
		}, "https://gateway.example.com", func(value string) error {
			settings.URL, err = normalizeGatewayURL(value)
			return err
		}); err != nil || !ok {
			return cmpErr(err, errors.New("gateway setup canceled"))
		}
		if ok, err := runAgentSecretInputTUI(stdin, stderr, "Gateway key", []string{
			"  One of the keys the gateway's operator set in DARI_GATEWAY_KEYS.",
		}, func(value string) error {
			if err := checkSelfHostedGateway(ctx, settings.URL, value); err != nil {
				return err
			}
			settings.Key = value
			return nil
		}); err != nil || !ok {
			return cmpErr(err, errors.New("gateway setup canceled"))
		}
		return switchGatewayMode(ctx, settings, stdin, stderr)
	}
}

func cmpErr(err, fallback error) error {
	if err != nil {
		return err
	}
	return fallback
}

// askAutoRoutingKey offers auto-routing, which needs a Dari API key. An empty
// answer skips it.
func askAutoRoutingKey(stdin io.Reader, stderr io.Writer) (string, error) {
	choice, err := runAgentChoiceTUI(stdin, stderr, "Auto-routing", []string{
		"  Dari's routing policy picks the model for each request. It needs a Dari API key,",
		"  and sends Dari the recent conversation to choose; models still run on your accounts.",
		"",
	}, []agentChoiceOption{
		{label: "Skip for now", description: "Start on the first model you can use; switch with /model."},
		{label: "Add a Dari API key", description: "Create one at https://app.dari.dev."},
	})
	if err != nil || choice == 0 {
		return "", err
	}
	key := ""
	_, err = runAgentSecretInputTUI(stdin, stderr, "Dari API key", nil, func(value string) error {
		key = value
		return nil
	})
	return key, err
}

// localProviderKeys are the provider API keys the Accounts page saves for a
// local gateway, by the environment variable the gateway reads: one for each
// provider in gatewayCatalogProviders, so every model the picker offers can
// be served.
var localProviderKeys = []struct{ name, article, env string }{
	{"Anthropic", "an", "ANTHROPIC_API_KEY"},
	{"OpenAI", "an", "OPENAI_API_KEY"},
	{"DeepSeek", "a", "DEEPSEEK_API_KEY"},
	{"xAI", "an", "XAI_API_KEY"},
	{"Meta", "a", "META_API_KEY"},
	{"Fireworks", "a", "FIREWORKS_API_KEY"},
	{"OpenCode Go", "an", "OPENCODE_API_KEY"},
}

// allSubscriptionProviders are the plans `dari accounts` offers; it is not
// tied to one agent.
var allSubscriptionProviders = []agentSubscriptionProvider{claudeSubscription, codexSubscription, museSubscription, opencodeGoSubscription}

// saveLocalGateway saves a local gateway's settings and restarts it to serve
// them.
func saveLocalGateway(ctx context.Context, gw *gatewayConfig, stderr io.Writer) error {
	if err := gateway.Save(gw.settings); err != nil {
		return err
	}
	if err := gateway.Restart(ctx, gw.settings, cliVersion); err != nil {
		return err
	}
	return gw.ensure(ctx, stderr)
}

// gatewayAgentModels lists a gateway's models for a launch. When no account
// can serve them yet, it opens the Accounts page first.
func gatewayAgentModels(ctx context.Context, gw *gatewayConfig, launch agentLaunch, stdin io.Reader, stderr io.Writer) (agents.Models, error) {
	if err := gw.ensure(ctx, stderr); err != nil {
		return agents.Models{}, err
	}
	models, err := routerModels(ctx, gw.url, gw.key, launch.name)
	if errors.Is(err, errNoProviderCredentials) && agentInputIsTerminal(stdin) {
		agentStep(stderr, "Connect an account to start")
		page := accountsPage{client: api.New(gw.url).WithBearer(gw.key), providers: agentSubscriptionProviders(launch.name), gw: gw}
		if _, err := page.run(ctx, stdin, stderr); err != nil {
			return agents.Models{}, err
		}
		models, err = routerModels(ctx, gw.url, gw.key, launch.name)
	}
	// A local gateway's first launch chooses its models, as a hosted
	// router's first launch does.
	if err == nil && gw.local && agentInputIsTerminal(stdin) {
		if lists, listsErr := fetchGatewayModelLists(ctx, gw); listsErr == nil && !lists.Chosen {
			if err := chooseGatewayModels(ctx, gw, "", stdin, stderr); err != nil {
				return agents.Models{}, err
			}
			models, err = routerModels(ctx, gw.url, gw.key, launch.name)
		}
	}
	return models, err
}

// gatewayModelConfig is one model of a gateway router's model list.
type gatewayModelConfig struct {
	ID       string   `json:"id"`
	Thinking []string `json:"thinking,omitempty"`
}

// gatewayModelLists are the model lists of a gateway's default router: its
// own, and each coding agent's that has one. Chosen is false while the router
// serves the gateway's built-in default models.
type gatewayModelLists struct {
	Models      []gatewayModelConfig            `json:"models"`
	AgentModels map[string][]gatewayModelConfig `json:"agent_models"`
	Chosen      bool                            `json:"chosen"`
}

// offered is the list the router offers agent: its own when it has one, else
// the router's. "" is no agent.
func (lists gatewayModelLists) offered(agent string) []gatewayModelConfig {
	if own := lists.AgentModels[agentSetups[agent].codingAgent]; len(own) > 0 {
		return own
	}
	return lists.Models
}

// gatewayModelListsPath is where a gateway serves and saves its default
// router's own list, or agent's.
func gatewayModelListsPath(agent string) string {
	if agent == "" {
		return "/v1/router/models"
	}
	return "/v1/router/models/" + agentSetups[agent].codingAgent
}

func fetchGatewayModelLists(ctx context.Context, gw *gatewayConfig) (gatewayModelLists, error) {
	var lists gatewayModelLists
	err := api.New(gw.url).WithBearer(gw.key).Do(ctx, http.MethodGet, gatewayModelListsPath(""), nil, &lists)
	return lists, gatewayModelListsError(err)
}

// saveGatewayModels saves chosen on the gateway as its default router's own
// list, or as agent's. A nil list removes the saved one, so the gateway goes
// back to its config file's. The gateway serves the change at once.
func saveGatewayModels(ctx context.Context, gw *gatewayConfig, agent string, chosen []gatewayModelConfig) error {
	client := api.New(gw.url).WithBearer(gw.key)
	if chosen == nil {
		return gatewayModelListsError(client.Do(ctx, http.MethodDelete, gatewayModelListsPath(agent), nil, nil))
	}
	body := map[string]any{"models": chosen}
	return gatewayModelListsError(client.Do(ctx, http.MethodPut, gatewayModelListsPath(agent), body, nil))
}

// gatewayModelListsError is the message a gateway refused a model list with.
// A gateway released before it saved model lists has no such path.
func gatewayModelListsError(err error) error {
	he := api.AsHTTPError(err)
	if he == nil {
		return err
	}
	var refused struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal([]byte(he.Detail), &refused)
	switch {
	case refused.Error.Code == "not_found":
		return errors.New("this gateway does not save model lists yet; update Dari Gateway, or set `models` in its config file")
	case refused.Error.Message != "":
		return errors.New(refused.Error.Message)
	}
	return api.HumanError(err)
}

// gatewayCatalogProviders are the providers the gateway model picker offers:
// those in the gateway's bundled catalog that take a subscription or one API
// key.
const gatewayCatalogProviders = "anthropic,openai,deepseek,xai,meta,fireworks"

// chooseGatewayModels opens the hosted router's model picker over the
// gateway's catalog and saves the choice on the gateway. The choice is the
// gateway's models, or with agent that agent's own list, which it is served
// in place of them.
func chooseGatewayModels(ctx context.Context, gw *gatewayConfig, agent string, stdin io.Reader, stderr io.Writer) error {
	if err := gw.ensure(ctx, stderr); err != nil {
		return err
	}
	lists, err := fetchGatewayModelLists(ctx, gw)
	if err != nil {
		return err
	}
	current := lists.offered(agent)
	var catalog struct {
		Data []struct {
			ID             string   `json:"id"`
			Name           string   `json:"name"`
			Provider       string   `json:"provider"`
			ThinkingLevels []string `json:"thinking_levels"`
		} `json:"data"`
	}
	client := api.New(gw.url).WithBearer(gw.key)
	if err := client.Do(ctx, http.MethodGet, "/v1/models?detail=1&provider="+gatewayCatalogProviders, nil, &catalog); err != nil {
		if strings.Contains(err.Error(), "provider_credentials_missing") {
			return errNoProviderCredentials
		}
		return api.HumanError(err)
	}
	models := []agentModel{}
	known := map[string][]string{}
	for _, model := range catalog.Data {
		known[model.ID] = model.ThinkingLevels
		models = append(models, agentModel{ID: model.ID, DisplayName: model.Name, Provider: model.Provider, SupportedLevels: model.ThinkingLevels})
	}
	// Only Dari's canonical models are offered, as on a hosted router. A
	// canonical model newer than the bundled catalog is still served by the
	// gateway, so it is offered with Dari's own name and thinking levels.
	var canonical struct {
		Data []struct {
			ID             string   `json:"id"`
			Name           string   `json:"name"`
			ThinkingLevels []string `json:"thinking_levels"`
		} `json:"data"`
	}
	if err := client.Do(ctx, http.MethodGet, "/v1/canonical-models", nil, &canonical); err != nil {
		return gatewayModelListsError(err)
	}
	canonicalIDs := map[string]bool{}
	for _, model := range canonical.Data {
		canonicalIDs[model.ID] = true
	}
	offered := []agentModel{}
	for _, model := range models {
		if canonicalIDs[model.ID] {
			offered = append(offered, model)
		}
	}
	for _, model := range canonical.Data {
		if _, ok := known[model.ID]; !ok {
			known[model.ID] = model.ThinkingLevels
			offered = append(offered, agentModel{ID: model.ID, DisplayName: model.Name, Provider: providerOf(model.ID), SupportedLevels: model.ThinkingLevels})
		}
	}
	models = offered
	defaults := []string{}
	currentLevels := map[string][]string{}
	for _, model := range current {
		defaults = append(defaults, model.ID)
		// A model without thinking levels in the config offers all of them.
		currentLevels[model.ID] = model.Thinking
		if len(model.Thinking) == 0 {
			currentLevels[model.ID] = known[model.ID]
		}
		if !slices.ContainsFunc(models, func(m agentModel) bool { return m.ID == model.ID }) {
			models = append(models, agentModel{ID: model.ID, DisplayName: model.ID, Provider: providerOf(model.ID)})
		}
	}
	// Group by provider in a fixed order, then by name within each group;
	// a raw id sorts by its model name, not its provider prefix.
	providerRank := func(provider string) int {
		if i := slices.Index(strings.Split(gatewayCatalogProviders, ","), provider); i >= 0 {
			return i
		}
		return len(gatewayCatalogProviders)
	}
	sortName := func(m agentModel) string {
		if _, name, ok := strings.Cut(m.ID, "/"); ok && m.DisplayName == m.ID {
			return strings.ToLower(name)
		}
		return strings.ToLower(m.DisplayName)
	}
	// Models the gateway already serves come first, in the order they serve.
	servedFirst := func(m agentModel) int {
		if i := slices.Index(defaults, m.ID); i >= 0 {
			return i
		}
		return len(defaults)
	}
	sort.SliceStable(models, func(i, j int) bool {
		if si, sj := servedFirst(models[i]), servedFirst(models[j]); si != sj {
			return si < sj
		}
		pi, pj := providerRank(models[i].Provider), providerRank(models[j].Provider)
		if pi != pj {
			return pi < pj
		}
		return sortName(models[i]) < sortName(models[j])
	})
	title, saved := "Models", "Models"
	note := []string{"  Models from a provider serve once it has a connected account or API key."}
	if agent != "" {
		title = "Models for " + agentSetups[agent].label
		saved = agentSetups[agent].label + " models"
		note = append(note, fmt.Sprintf("  %s is offered these in place of the gateway's models. Undo with `dari gateway models --agent %s --reset`.", agentSetups[agent].label, agent))
	}
	choices, err := selectAgentModels(stdin, stderr, title, note, false, models, defaults, currentLevels, nil, nil)
	if err != nil {
		return err
	}
	if len(choices) == 0 {
		return errors.New("choose at least one model")
	}
	// Without auto-routing the gateway serves the first available model, so
	// models it already served keep their order and new ones follow.
	sort.SliceStable(choices, func(i, j int) bool {
		return position(defaults, choices[i].ID) < position(defaults, choices[j].ID)
	})
	chosen := make([]gatewayModelConfig, 0, len(choices))
	for _, choice := range choices {
		chosen = append(chosen, gatewayModelConfig{ID: choice.ID, Thinking: choice.Levels})
	}
	if err := saveGatewayModels(ctx, gw, agent, chosen); err != nil {
		return err
	}
	agentStep(stderr, fmt.Sprintf("%s: %d selected", saved, len(chosen)))
	return nil
}

// providerOf is the provider prefix of a provider/model id.
func providerOf(id string) string {
	provider, _, _ := strings.Cut(id, "/")
	return provider
}

// position is id's index in ids, or len(ids) when absent.
func position(ids []string, id string) int {
	if i := slices.Index(ids, id); i >= 0 {
		return i
	}
	return len(ids)
}

// reportGatewayModels says what a gateway launch starts on. Without Dari
// Auto Routing it starts on the first model, as a hosted router without the
// Autorouting plan does. On a local gateway it also adds the chosen models no
// connected account or API key serves yet, so the agent can list every chosen
// model, and names them.
func reportGatewayModels(ctx context.Context, gw *gatewayConfig, agent string, models agents.Models, stderr io.Writer) agents.Models {
	if !models.Routing && len(models.Enabled) > 0 {
		hint := "Switch models with /model"
		if gw.local {
			hint += ", or turn on auto-routing with `dari gateway auto-routing <dari-api-key>`"
		}
		agentPrintln(stderr, fmt.Sprintf("Starting on %s. %s.", models.Default(), hint))
	}
	if !gw.local {
		return models
	}
	lists, err := fetchGatewayModelLists(ctx, gw)
	if err != nil {
		return models
	}
	for _, model := range lists.offered(agent) {
		if !slices.Contains(models.Enabled, model.ID) {
			models.Unavailable = append(models.Unavailable, model.ID)
		}
	}
	if len(models.Unavailable) > 0 {
		agentPrintln(stderr, fmt.Sprintf("Not available until their provider has an account or API key: %s. Connect one with `dari accounts`.", strings.Join(models.Unavailable, ", ")))
	}
	return models
}
