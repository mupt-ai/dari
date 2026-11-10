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

	"github.com/mupt-ai/dari-cli/internal/api"
	"github.com/mupt-ai/dari-cli/internal/auth"
	"github.com/mupt-ai/dari-cli/internal/cli/agents"
	"github.com/mupt-ai/dari-cli/internal/gateway"
	"github.com/mupt-ai/dari-cli/internal/state"
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

// gatewayModeDone is the line each mode prints once saved.
var gatewayModeDone = map[gateway.Mode]string{
	gateway.ModeHosted:     "Routing through hosted Dari",
	gateway.ModeLocal:      "Routing through a local gateway",
	gateway.ModeSelfHosted: "Routing through a self-hosted gateway",
}

// checkSelfHostedGateway confirms a self-hosted gateway accepts key.
func checkSelfHostedGateway(ctx context.Context, url, key string) error {
	if _, err := routerModels(ctx, url, key); err != nil && !errors.Is(err, errNoProviderCredentials) {
		return fmt.Errorf("the gateway did not accept this key: %v", err)
	}
	return nil
}

// setGatewayModeFromFlags saves the routing choice named by --mode without a
// terminal, for scripts and agents. Flags stand in for the menu's answers.
func setGatewayModeFromFlags(ctx context.Context, mode, url, key, autoRoutingKey string, stderr io.Writer) error {
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
	if err := saveGatewayMode(ctx, settings); err != nil {
		return err
	}
	agentStep(stderr, gatewayModeDone[settings.Mode])
	return nil
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
			description: "Runs on this machine; requests go straight to model providers. Only you can use it: no team sharing or analytics.",
			done:        gatewayModeDone[gateway.ModeLocal],
		},
		gatewaySetupSelfHosted: {
			label:       "Self-hosted",
			description: "Connect to a Dari Gateway your team runs on its own server, so everyone shares its accounts and routing.",
			done:        gatewayModeDone[gateway.ModeSelfHosted],
		},
	})
	if err != nil {
		return err
	}
	switch choice {
	case gatewaySetupHosted:
		return saveGatewayMode(ctx, gateway.Settings{Mode: gateway.ModeHosted})
	case gatewaySetupLocal:
		settings := gateway.Settings{Mode: gateway.ModeLocal}
		if previous, _, _ := gateway.Load(); previous.AutoRoutingKey == "" {
			if settings.AutoRoutingKey, err = askAutoRoutingKey(stdin, stderr); err != nil {
				return err
			}
		}
		return saveGatewayMode(ctx, settings)
	default:
		settings := gateway.Settings{Mode: gateway.ModeSelfHosted}
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
		return saveGatewayMode(ctx, settings)
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
// local gateway, by the environment variable the gateway reads.
var localProviderKeys = []struct{ name, env string }{
	{"Anthropic", "ANTHROPIC_API_KEY"},
	{"OpenAI", "OPENAI_API_KEY"},
}

// manageGatewayAccounts is the Accounts page for a gateway: its connected
// subscriptions, with options to connect more, and on a local gateway, API
// keys and auto-routing.
func manageGatewayAccounts(ctx context.Context, gw *gatewayConfig, agent string, stdin io.Reader, stderr io.Writer) error {
	if !agentInputIsTerminal(stdin) {
		return errors.New("--connect needs an interactive terminal; use `dari credentials subscription connect` instead")
	}
	client := api.New(gw.url).WithBearer(gw.key)
	providers := agentSubscriptionProviders(agent)
	for {
		var listed struct {
			Credentials []subscriptionCredential `json:"credentials"`
		}
		if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials", nil, &listed); err != nil {
			return api.HumanError(err)
		}
		subscriptions := personalSubscriptions(listed.Credentials)
		lines := agentSubscriptionLines(subscriptions, len(providers) > 1)
		for _, key := range localProviderKeys {
			if gw.settings.ProviderKeys[key.env] != "" {
				lines = slices.Insert(lines, len(lines)-1, "  "+key.name+"  "+ansiGray+"API key"+ansiReset)
			}
		}
		options := []agentChoiceOption{{label: "Continue", done: "Accounts ready"}}
		actions := []func() error{nil}
		for _, provider := range providers {
			options = append(options, agentChoiceOption{label: "Connect a " + provider.name + " account"})
			actions = append(actions, func() error {
				return connectAgentPersonalSubscription(ctx, provider, client, stdin, stderr, "")
			})
		}
		if gw.local {
			for _, key := range localProviderKeys {
				options = append(options, agentChoiceOption{label: "Add an " + key.name + " API key"})
				actions = append(actions, func() error {
					_, err := runAgentSecretInputTUI(stdin, stderr, key.name+" API key", nil, func(value string) error {
						if gw.settings.ProviderKeys == nil {
							gw.settings.ProviderKeys = map[string]string{}
						}
						gw.settings.ProviderKeys[key.env] = value
						return saveLocalGateway(ctx, gw, stderr)
					})
					return err
				})
			}
			label := "Add a Dari API key for auto-routing"
			if gw.settings.AutoRoutingKey != "" {
				label = "Replace the auto-routing Dari API key"
			}
			options = append(options, agentChoiceOption{label: label})
			actions = append(actions, func() error {
				_, err := runAgentSecretInputTUI(stdin, stderr, "Dari API key", nil, func(value string) error {
					gw.settings.AutoRoutingKey = value
					return saveLocalGateway(ctx, gw, stderr)
				})
				return err
			})
		}
		choice, err := runAgentChoiceTUI(stdin, stderr, "Accounts", lines, options)
		if err != nil {
			return err
		}
		if actions[choice] == nil {
			return nil
		}
		if err := actions[choice](); err != nil {
			return err
		}
	}
}

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
	if launch.connect {
		if err := manageGatewayAccounts(ctx, gw, launch.name, stdin, stderr); err != nil {
			return agents.Models{}, err
		}
	}
	models, err := routerModels(ctx, gw.url, gw.key)
	if errors.Is(err, errNoProviderCredentials) && agentInputIsTerminal(stdin) && !launch.connect {
		agentStep(stderr, "Connect an account to start")
		if err := manageGatewayAccounts(ctx, gw, launch.name, stdin, stderr); err != nil {
			return agents.Models{}, err
		}
		models, err = routerModels(ctx, gw.url, gw.key)
	}
	// A local gateway's first launch chooses its models, as a hosted
	// router's first launch does.
	if err == nil && gw.local && agentInputIsTerminal(stdin) && !localGatewayModelsChosen() {
		if err := chooseLocalGatewayModels(ctx, gw, stdin, stderr); err != nil {
			return agents.Models{}, err
		}
		models, err = routerModels(ctx, gw.url, gw.key)
	}
	return models, err
}

// localGatewayModelsChosen reports whether the local gateway serves models
// the user chose rather than its built-in default.
func localGatewayModelsChosen() bool {
	path, err := gateway.ConfigPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}

// gatewayModelConfig is one model of a gateway router's config.
type gatewayModelConfig struct {
	ID       string   `json:"id"`
	Thinking []string `json:"thinking,omitempty"`
}

// localGatewayModels is the local gateway's default router, as its config
// file sets it, else the gateway's built-in default.
func localGatewayModels(ctx context.Context) ([]gatewayModelConfig, error) {
	return gatewayRouterModels(gateway.EffectiveConfig(ctx, cliVersion))
}

// gatewayRouterModels reads the default router's models from a gateway
// config printed as JSON.
func gatewayRouterModels(raw []byte, err error) ([]gatewayModelConfig, error) {
	if err != nil {
		return nil, err
	}
	var config struct {
		Routers map[string]struct {
			Models []gatewayModelConfig `json:"models"`
		} `json:"routers"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil, fmt.Errorf("read the gateway config: %w", err)
	}
	return config.Routers["default"].Models, nil
}

// gatewayCatalogProviders are the providers the local model picker offers:
// those in the gateway's bundled catalog that take a subscription or one API
// key.
const gatewayCatalogProviders = "anthropic,openai,deepseek,xai,meta,fireworks"

// chooseLocalGatewayModels opens the hosted router's model picker over the
// gateway's catalog, then saves the choice as the local gateway's config and
// restarts it.
func chooseLocalGatewayModels(ctx context.Context, gw *gatewayConfig, stdin io.Reader, stderr io.Writer) error {
	if err := gw.ensure(ctx, stderr); err != nil {
		return err
	}
	current, err := localGatewayModels(ctx)
	if err != nil {
		return err
	}
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
	// canonical model the bundled catalog lacks is still served by the gateway,
	// so it is offered by id.
	canonicalRaw, err := gateway.CanonicalModels(ctx, cliVersion)
	if err != nil {
		return err
	}
	var canonical []string
	if err := json.Unmarshal(canonicalRaw, &canonical); err != nil {
		return fmt.Errorf("read the canonical models: %w", err)
	}
	offered := []agentModel{}
	for _, model := range models {
		if slices.Contains(canonical, model.ID) {
			offered = append(offered, model)
		}
	}
	for _, id := range canonical {
		if _, ok := known[id]; !ok {
			offered = append(offered, agentModel{ID: id, DisplayName: id, Provider: providerOf(id)})
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
	choices, err := selectAgentModels(stdin, stderr, "Models", []string{
		"  Models from a provider serve once it has a connected account or API key.",
	}, false, models, defaults, currentLevels, nil, nil)
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
	path, err := gateway.ConfigPath()
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(map[string]any{"routers": map[string]any{"default": map[string]any{"models": chosen}}}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	agentStep(stderr, fmt.Sprintf("Models: %d selected", len(chosen)))
	return gateway.Restart(ctx, gw.settings, cliVersion)
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
