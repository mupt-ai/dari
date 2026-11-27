package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/cli/agents"
)

// gatewayMissing is a gateway model no account or API key serves yet, and
// what would serve it for the launched agent.
type gatewayMissing struct {
	model string
	// providers serve the model: the one its router spec names, else those
	// the gateway's catalog runs it on.
	providers []string
	// plans are the subscriptions that serve one of the providers for this
	// agent: a Claude subscription serves only Claude Code.
	plans []agentSubscriptionProvider
	// keys index localProviderKeys for the providers' API keys. Only a local
	// gateway's keys are the CLI's to set; another gateway reads them from
	// its own environment.
	keys  []int
	local bool
}

// agentLimitedPlans serve only their own agent, as the gateway serves them:
// a Claude Code plan only Claude Code, and a Muse Code plan only Muse Code.
// Every other plan serves any agent.
var agentLimitedPlans = []agentSubscriptionProvider{claudeSubscription, museSubscription}

// gatewayModelProvider is the provider a gateway model's row shows: the one
// its router spec names, else the one its ID starts with.
func gatewayModelProvider(model gatewayModelConfig) string {
	if model.Provider != "" {
		return model.Provider
	}
	return providerOf(model.ID)
}

// fetchGatewayModelProviders are, by model ID, the providers whose plans and
// API keys serve each canonical model on the gateway when a router spec names
// none.
func fetchGatewayModelProviders(ctx context.Context, gw *gatewayConfig) (map[string][]string, error) {
	var canonical struct {
		Data []struct {
			ID        string   `json:"id"`
			Providers []string `json:"providers"`
		} `json:"data"`
	}
	if err := api.New(gw.url).WithBearer(gw.key).Do(ctx, http.MethodGet, "/v1/canonical-models", nil, &canonical); err != nil {
		return nil, gatewayModelListsError(err)
	}
	providers := map[string][]string{}
	for _, model := range canonical.Data {
		providers[model.ID] = model.Providers
	}
	return providers, nil
}

// gatewayMissingModels are the models the router offers agent that are not
// among the enabled ones, with what would serve each. catalog is
// fetchGatewayModelProviders'.
func gatewayMissingModels(gw *gatewayConfig, agent string, offered []gatewayModelConfig, enabled []string, catalog map[string][]string) []gatewayMissing {
	var missing []gatewayMissing
	for _, model := range offered {
		if slices.Contains(enabled, model.ID) {
			continue
		}
		providers := catalog[model.ID]
		if model.Provider != "" || len(providers) == 0 {
			providers = []string{gatewayModelProvider(model)}
		}
		need := gatewayMissing{model: model.ID, providers: providers, local: gw.local}
		for _, plan := range allSubscriptionProviders {
			limited := slices.Contains(agentLimitedPlans, plan) && !slices.Contains(agentSetups[agent].subscriptions, plan)
			if !limited && slices.Contains(providers, plan.routerProvider) {
				need.plans = append(need.plans, plan)
			}
		}
		for i, key := range localProviderKeys {
			// A plan-only provider is offered as its plan.
			if id := localProviderKeyID(key.name); slices.Contains(providers, id) && !subscriptionOnlyProviders[id] {
				need.keys = append(need.keys, i)
			}
		}
		missing = append(missing, need)
	}
	return missing
}

// fetchGatewayMissing reads the models the router at baseURL offers agent,
// and which of them are missing: not among enabled.
func fetchGatewayMissing(ctx context.Context, gw *gatewayConfig, baseURL, agent string, enabled []string) ([]gatewayModelConfig, []gatewayMissing, error) {
	lists, err := fetchGatewayRouterModelLists(ctx, gw, baseURL)
	if err != nil {
		return nil, nil, err
	}
	catalog, err := fetchGatewayModelProviders(ctx, gw)
	if err != nil {
		return nil, nil, err
	}
	offered := lists.offered(agent)
	return offered, gatewayMissingModels(gw, agent, offered, enabled, catalog), nil
}

// orList joins items as "a", "a or b", or "a, b, or c".
func orList(items []string) string {
	if len(items) < 3 {
		return strings.Join(items, " or ")
	}
	return strings.Join(items[:len(items)-1], ", ") + ", or " + items[len(items)-1]
}

// keyNames are the names of the missing model's API keys, or on a gateway
// that is not local, their environment variables.
func (need gatewayMissing) keyNames() []string {
	names := make([]string, len(need.keys))
	for i, key := range need.keys {
		names[i] = localProviderKeys[key].name
		if !need.local {
			names[i] = localProviderKeys[key].env
		}
	}
	return names
}

// help says what to run so the model is served.
func (need gatewayMissing) help() string {
	var ways []string
	for _, plan := range need.plans {
		for name, known := range subscriptionProviders {
			if known.id == plan.id {
				ways = append(ways, fmt.Sprintf("connect %s (`dari accounts subscription connect %s`)", plan.name, name))
			}
		}
	}
	switch {
	case len(need.keys) > 0 && need.local:
		ids := make([]string, len(need.keys))
		for i, key := range need.keys {
			ids[i] = localProviderKeyID(localProviderKeys[key].name)
		}
		provider := ids[0]
		if len(ids) > 1 {
			provider = "<" + strings.Join(ids, "|") + ">"
		}
		ways = append(ways, fmt.Sprintf("add %s %s key (`dari accounts key %s <key>`)", localProviderKeys[need.keys[0]].article, orList(need.keyNames()), provider))
	case len(need.keys) > 0:
		ways = append(ways, "set "+orList(need.keyNames())+" on the gateway")
	case len(ways) == 0:
		// Nothing the catalog knows serves it.
		ways = append(ways, "name who serves it with `provider:` in the router spec, or set "+need.providers[0]+"'s API key on the gateway")
	}
	return strings.Join(ways, " or ")
}

// note is the short line under a missing model on the connect page: what
// serves it, and why a plan one might expect is not offered.
func (need gatewayMissing) note() string {
	var ways []string
	for _, plan := range need.plans {
		ways = append(ways, plan.name)
	}
	if len(need.keys) > 0 {
		key := orList(need.keyNames()) + " key"
		if !need.local {
			key = orList(need.keyNames()) + " on the gateway"
		}
		ways = append(ways, key)
	}
	note := "Needs " + strings.Join(ways, " or ")
	if len(ways) == 0 {
		note = "Name its provider in the router spec"
	}
	for _, plan := range agentLimitedPlans {
		if slices.Contains(need.providers, plan.routerProvider) && !slices.Contains(need.plans, plan) {
			note += " · " + plan.name + " plans serve " + plan.name + " only"
		}
	}
	return note
}

// sources are the connect page's ways to serve the model: each plan to
// connect, then on a local gateway each API key to add, or skipping it.
func (need gatewayMissing) sources() []agentModelSource {
	var ways []agentModelSource
	for _, plan := range need.plans {
		ways = append(ways, agentModelSource{kind: "connect", provider: plan.routerProvider, credentialID: plan.id, label: "Connect " + plan.name})
	}
	if need.local {
		for _, key := range need.keys {
			ways = append(ways, agentModelSource{kind: "add-key", provider: localProviderKeyID(localProviderKeys[key].name), label: "Add " + localProviderKeys[key].name + " Key"})
		}
	}
	return append(ways, agentModelSource{kind: "skip", provider: need.providers[0], label: "Skip For Now"})
}

// gatewayMissingLines say, one line for each way to serve them, which models
// are not served yet and what to run for each.
func gatewayMissingLines(missing []gatewayMissing) []string {
	var helps []string
	models := map[string][]string{}
	for _, need := range missing {
		help := need.help()
		if _, ok := models[help]; !ok {
			helps = append(helps, help)
		}
		models[help] = append(models[help], need.model)
	}
	lines := make([]string, 0, len(helps))
	for _, help := range helps {
		lines = append(lines, fmt.Sprintf("Not available yet: %s. To use: %s.", strings.Join(models[help], ", "), help))
	}
	return lines
}

// connectGatewayMissing shows the router's models with what each missing one
// needs, a plan to connect or an API key to add, and runs the one picked,
// until none is missing or the user continues without them. It returns the
// router's models as served afterwards.
func connectGatewayMissing(ctx context.Context, gw *gatewayConfig, baseURL string, launch agentLaunch, stdin io.Reader, stderr io.Writer) (agents.Models, error) {
	label := agentSetups[launch.name].label
	cursor, warning := 0, ""
	for {
		models, err := routerModels(ctx, baseURL, gw.key, launch.name)
		if err != nil && !errors.Is(err, errNoProviderCredentials) {
			return agents.Models{}, err
		}
		offered, missing, missingErr := fetchGatewayMissing(ctx, gw, baseURL, launch.name, models.Enabled)
		if missingErr != nil {
			return models, err
		}
		if len(missing) == 0 {
			return models, err
		}
		rows := make([]agentModel, len(offered))
		sources := map[string][]agentModelSource{}
		ids := make([]string, len(offered))
		for i, model := range offered {
			provider := gatewayModelProvider(model)
			rows[i] = agentModel{ID: model.ID, DisplayName: model.ID, Provider: provider}
			ids[i] = model.ID
			sources[model.ID] = []agentModelSource{{kind: "ready", provider: provider, label: "Ready"}}
		}
		for _, need := range missing {
			sources[need.model] = need.sources()
		}
		p := newAgentPickerState(rows, ids, nil, nil, sources)
		slices.SortStableFunc(p.rows, func(a, b agentPickerRow) int { return slices.Index(ids, a.model.ID) - slices.Index(ids, b.model.ID) })
		p.paying, p.fixed, p.cursor, p.warning = true, true, cursor, warning
		warning = ""
		for i := range p.rows {
			if j := slices.IndexFunc(missing, func(need gatewayMissing) bool { return need.model == p.rows[i].model.ID }); j >= 0 {
				p.rows[i].note = missing[j].note()
			}
		}
		var note []string
		if _, pickErr := runAgentPickerState(stdin, stderr, "What "+label+"'s Models Need", note, false, p); pickErr != nil {
			return agents.Models{}, pickErr
		}
		if p.action < 0 {
			// Continued: what was skipped stays unavailable.
			return models, err
		}
		cursor = p.cursor
		row := p.rows[p.action]
		step := row.sources[row.source]
		switch step.kind {
		case "connect":
			plan := allSubscriptionProviders[slices.IndexFunc(allSubscriptionProviders, func(plan agentSubscriptionProvider) bool { return plan.id == step.credentialID })]
			connectErr := connectAgentPersonalSubscription(ctx, plan, gatewayRouterClient(gw), stdin, stderr, "")
			if errors.Is(connectErr, errAgentQuit) {
				return agents.Models{}, connectErr
			}
			if connectErr != nil && !errors.Is(connectErr, errAgentChoiceCanceled) {
				warning = connectErr.Error()
			}
		case "add-key":
			key := localProviderKeys[slices.IndexFunc(localProviderKeys, func(key struct{ name, article, env string }) bool {
				return localProviderKeyID(key.name) == step.provider
			})]
			_, keyErr := runAgentSecretInputTUI(stdin, stderr, key.name+" API Key", nil, func(value string) error {
				return setLocalProviderKey(ctx, gw, stderr, key.env, value)
			})
			if errors.Is(keyErr, errAgentQuit) {
				return agents.Models{}, keyErr
			}
			if keyErr != nil && !errors.Is(keyErr, errAgentChoiceCanceled) {
				warning = keyErr.Error()
			}
		}
	}
}
