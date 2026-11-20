package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// gatewayMissing is a gateway model no account or API key serves yet, and
// what would serve it for the launched agent.
type gatewayMissing struct {
	model    string
	provider string
	// plans are the subscriptions that serve the provider for this agent: a
	// Claude subscription serves only Claude Code.
	plans []agentSubscriptionProvider
	// key indexes localProviderKeys for the provider's API key, or is -1
	// when it has none there. Only a local gateway's keys are the CLI's to
	// set; another gateway reads them from its own environment.
	key   int
	local bool
}

// gatewayModelProvider is the provider that serves a gateway model: the one
// its router spec names, else the one its ID starts with.
func gatewayModelProvider(model gatewayModelConfig) string {
	if model.Provider != "" {
		return model.Provider
	}
	provider, _, _ := strings.Cut(model.ID, "/")
	return provider
}

// gatewayMissingModels are the models the router offers agent that are not
// among the enabled ones, with what would serve each.
func gatewayMissingModels(gw *gatewayConfig, agent string, offered []gatewayModelConfig, enabled []string) []gatewayMissing {
	var missing []gatewayMissing
	for _, model := range offered {
		if slices.Contains(enabled, model.ID) {
			continue
		}
		provider := gatewayModelProvider(model)
		need := gatewayMissing{model: model.ID, provider: provider, local: gw.local}
		for _, plan := range templateSubscriptions(agentSetups[agent]) {
			if plan.routerProvider == provider {
				need.plans = append(need.plans, plan)
			}
		}
		need.key = slices.IndexFunc(localProviderKeys, func(key struct{ name, article, env string }) bool {
			return strings.ToLower(strings.ReplaceAll(key.name, " ", "-")) == provider
		})
		missing = append(missing, need)
	}
	return missing
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
	case need.key >= 0 && need.local:
		key := localProviderKeys[need.key]
		ways = append(ways, fmt.Sprintf("add %s %s key (`dari accounts key %s <key>`)", key.article, key.name, need.provider))
	case need.key >= 0:
		ways = append(ways, "set "+localProviderKeys[need.key].env+" on the gateway")
	case len(ways) == 0:
		// No plan or known key is for this provider: an ID like
		// deepseek-ai/... names the model's owner, not who serves it.
		ways = append(ways, "name who serves it with `provider:` in the router spec, or set "+need.provider+"'s API key on the gateway")
	}
	return strings.Join(ways, " or ")
}

// note is the line under a missing model on the connect page: what it lacks,
// and why a plan one might expect is not offered.
func (need gatewayMissing) note() string {
	note := "No account or API key serves it yet"
	if need.key >= 0 && !need.local {
		note = "Needs " + localProviderKeys[need.key].env + " set on the gateway"
		if len(need.plans) > 0 {
			note = "Needs a subscription, or " + localProviderKeys[need.key].env + " set on the gateway"
		}
	}
	for _, plan := range allSubscriptionProviders {
		if plan.routerProvider == need.provider && !slices.Contains(need.plans, plan) {
			note += "; a " + plan.name + " subscription serves only " + plan.name
		}
	}
	return note
}

// gatewayMissingLines say, one provider a line, which models are not served
// yet and what to run for each.
func gatewayMissingLines(missing []gatewayMissing) []string {
	var providers []string
	byProvider := map[string][]gatewayMissing{}
	for _, need := range missing {
		if _, ok := byProvider[need.provider]; !ok {
			providers = append(providers, need.provider)
		}
		byProvider[need.provider] = append(byProvider[need.provider], need)
	}
	lines := make([]string, 0, len(providers))
	for _, provider := range providers {
		needs := byProvider[provider]
		models := make([]string, len(needs))
		for i, need := range needs {
			models[i] = need.model
		}
		lines = append(lines, fmt.Sprintf("Not available yet: %s. To use: %s.", strings.Join(models, ", "), needs[0].help()))
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
		lists, listsErr := fetchGatewayRouterModelLists(ctx, gw, baseURL)
		if listsErr != nil {
			return models, err
		}
		offered := lists.offered(launch.name)
		missing := gatewayMissingModels(gw, launch.name, offered, models.Enabled)
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
			var ways []agentModelSource
			for _, plan := range need.plans {
				ways = append(ways, agentModelSource{kind: "connect", provider: need.provider, credentialID: plan.id, label: "Connect " + plan.name})
			}
			if need.key >= 0 && need.local {
				ways = append(ways, agentModelSource{kind: "add-key", provider: need.provider, label: "Add " + localProviderKeys[need.key].name + " Key"})
			}
			sources[need.model] = append(ways, agentModelSource{kind: "skip", provider: need.provider, label: "Skip For Now"})
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
		note := []string{"A model runs once its provider has a subscription or API key on the gateway."}
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
				return strings.ToLower(strings.ReplaceAll(key.name, " ", "-")) == step.provider
			})]
			_, keyErr := runAgentSecretInputTUI(stdin, stderr, key.name+" API Key", nil, func(value string) error {
				if gw.settings.ProviderKeys == nil {
					gw.settings.ProviderKeys = map[string]string{}
				}
				gw.settings.ProviderKeys[key.env] = value
				return saveLocalGateway(ctx, gw, stderr)
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
