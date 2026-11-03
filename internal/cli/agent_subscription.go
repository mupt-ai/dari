package cli

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"slices"
	"strings"

	"github.com/mupt-ai/dari-cli/internal/api"
	"github.com/mupt-ai/dari-cli/internal/auth"
)

// routerProvider is the router provider whose models the subscription serves,
// and vendor the company whose sign-in connects it. A device-code sign-in shows
// a code to enter at the vendor; the others paste back the vendor's code.
type agentSubscriptionProvider struct {
	id, name, routerProvider, vendor string
	deviceCode                       bool
}

var (
	claudeSubscription = agentSubscriptionProvider{"anthropic_claude_code", "Claude Code", "anthropic", "Anthropic", false}
	codexSubscription  = agentSubscriptionProvider{"openai_codex", "ChatGPT", "openai", "OpenAI", true}
	// Muse Code subscriptions serve only Muse Code.
	museSubscription = agentSubscriptionProvider{"meta_muse", "Muse Code", "meta", "Meta", true}
)

// OpenCode, Pi, OpenClaw, and Hermes Agent use the organization's default
// router, but their subscription decision is per user and launcher, not
// implied by a cached router or login. It reports how many API keys the Accounts page connected.
func ensureDefaultAgentSubscription(ctx context.Context, agent string, client *api.Client, router agentRouter, stdin io.Reader, stderr io.Writer) (int, error) {
	optedOut, err := agentSubscriptionOptedOut(ctx, client, agent)
	if err != nil {
		return 0, err
	}
	resolution, resolveErr := resolveAgentPersonalSubscription(ctx, agentSubscriptionProviders(agent), client, stdin, stderr, optedOut)
	if resolution.preferenceChanged {
		if err := saveAgentSubscriptionOptOut(ctx, client, agent, !resolution.enabled); err != nil {
			return 0, err
		}
	}
	// Enable the shared router only when this launch newly connected a
	// subscription. Do not disable it when another user opts out, and do not
	// re-enable it just because a credential already exists. Accounts connected
	// before an error are stored, so route through them before reporting it.
	if resolution.connectedNow {
		if err := setAgentRouterSubscription(ctx, client, router, agentSubscriptionProviders(agent), true); err != nil {
			return 0, err
		}
	}
	return resolution.keysAdded, resolveErr
}

// connectAgentSubscriptionsOnRequest handles `dari <agent> --connect`: it
// opens the Accounts page, and once a subscription is added, routes this
// agent through subscriptions again even if it was set to managed billing.
// It reports how many API keys the page connected.
func connectAgentSubscriptionsOnRequest(ctx context.Context, agent string, access agentRoutingAccess, stdin io.Reader, stderr io.Writer) (int, error) {
	if !agentInputIsTerminal(stdin) {
		return 0, errors.New("--connect needs an interactive terminal; use `dari credentials subscription connect` instead")
	}
	client, err := auth.OrgKeyClient(access.apiURL)
	if err != nil {
		return 0, err
	}
	added, keys, manageErr := manageAgentSubscriptions(ctx, client, agentSubscriptionProviders(agent), stdin, stderr)
	if added == 0 {
		return keys, manageErr
	}
	if err := saveAgentSubscriptionOptOut(ctx, client, agent, false); err != nil {
		return keys, err
	}
	// Agents with their own router pick its subscriptions during setup; the
	// others share the default router.
	if agentSetups[agent].ownsRouter() {
		return keys, manageErr
	}
	routers, err := listAgentRouters(ctx, client)
	if err != nil {
		return keys, err
	}
	router, ok := findAgentRouter(routers, func(router agentRouter) bool { return router.IsDefault })
	if !ok {
		return keys, errors.New("organization has no default router")
	}
	if err := setAgentRouterSubscription(ctx, client, router, agentSubscriptionProviders(agent), true); err != nil {
		return keys, err
	}
	return keys, manageErr
}

// agentSubscriptionProviders are the subscriptions an agent can use, its own
// first.
func agentSubscriptionProviders(agent string) []agentSubscriptionProvider {
	return agentSetups[agent].subscriptions
}

// manageAgentSubscriptions is the Accounts page: the user's subscriptions
// from providers and the organization's API keys, with options to connect
// more. Each connection returns to the page. With nothing connected it offers
// Dari managed billing instead of continuing. It reports how many
// subscriptions and API keys it connected; the router's models move onto the
// keys once they are known.
func manageAgentSubscriptions(ctx context.Context, client *api.Client, providers []agentSubscriptionProvider, stdin io.Reader, stderr io.Writer) (int, int, error) {
	added, keysAdded := 0, 0
	for {
		var raw json.RawMessage
		if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials", nil, &raw); err != nil {
			return added, keysAdded, api.HumanError(err)
		}
		var listed struct {
			Credentials []subscriptionCredential `json:"credentials"`
		}
		var listedKeys struct {
			Credentials []agentProviderCredential `json:"credentials"`
		}
		if err := json.Unmarshal(raw, &listed); err != nil {
			return added, keysAdded, err
		}
		if err := json.Unmarshal(raw, &listedKeys); err != nil {
			return added, keysAdded, err
		}
		subscriptions := slices.DeleteFunc(personalSubscriptions(listed.Credentials), func(c subscriptionCredential) bool {
			return !slices.ContainsFunc(providers, func(p agentSubscriptionProvider) bool { return p.id == c.OAuthProvider })
		})
		keys := agentAPIKeys(listedKeys.Credentials)
		connected := len(subscriptions) > 0 || len(keys) > 0
		routing, err := autoroutingAllowed(ctx, client)
		if err != nil {
			return added, keysAdded, err
		}
		// Each option is a connect for one provider, an API key, Get
		// Autorouting, or the option that leaves the page.
		options := []agentChoiceOption{}
		connects := map[int]agentSubscriptionProvider{}
		finish := agentChoiceOption{label: "Use Dari managed billing", done: "Using Dari managed billing"}
		if connected {
			finish = agentChoiceOption{label: "Continue", done: fmt.Sprintf("Accounts: %d connected", len(subscriptions)+len(keys))}
			options = append(options, finish)
		}
		for _, provider := range providers {
			label := "Connect a " + provider.name + " account"
			if len(subscriptions) > 0 {
				label = "Connect another " + provider.name + " account"
			}
			connects[len(options)] = provider
			options = append(options, agentChoiceOption{label: label})
		}
		apiKey := len(options)
		if len(keys) == 0 {
			options = append(options, agentChoiceOption{label: "Connect an API key"})
		} else {
			options = append(options, agentChoiceOption{label: "Connect another API key"})
		}
		autorouting := -1
		if !routing {
			autorouting = len(options)
			options = append(options, agentChoiceOption{label: "Get auto-routing"})
		}
		if !connected {
			options = append(options, finish)
		}
		lines := agentAccountLines(subscriptions, keys, len(providers) > 1)
		choice, err := runAgentChoiceTUI(stdin, stderr, "Accounts", lines, options)
		if err != nil {
			return added, keysAdded, err
		}
		if choice == apiKey {
			saved, err := connectAgentAPIKey(ctx, client, stdin, stderr, keys)
			if err != nil {
				return added, keysAdded, err
			}
			if saved {
				keysAdded++
			}
			continue
		}
		if choice == autorouting {
			if _, err := getAutorouting(ctx, client, stdin, stderr); err != nil {
				return added, keysAdded, err
			}
			continue
		}
		provider, connect := connects[choice]
		if !connect {
			return added, keysAdded, nil
		}
		if err := connectAgentPersonalSubscription(ctx, provider, client, stdin, stderr, ""); err != nil {
			return added, keysAdded, err
		}
		added++
	}
}

// agentAccountLines lists the connected subscriptions, then API keys.
func agentAccountLines(subscriptions []subscriptionCredential, keys map[string]agentProviderCredential, showProvider bool) []string {
	if len(keys) == 0 {
		return agentSubscriptionLines(subscriptions, showProvider)
	}
	lines := []string{}
	if len(subscriptions) > 0 {
		lines = agentSubscriptionLines(subscriptions, showProvider)
		lines = lines[:len(lines)-1]
	}
	for _, provider := range slices.Sorted(maps.Keys(keys)) {
		key := keys[provider]
		lines = append(lines, "  "+cmp.Or(key.Label, key.Name, provider)+"  "+ansiGray+"API key"+ansiReset)
	}
	return append(lines, "")
}

// agentSubscriptionLines lists subscriptions in the order routing uses them,
// naming each one's provider when the page offers more than one.
func agentSubscriptionLines(subscriptions []subscriptionCredential, showProvider bool) []string {
	if len(subscriptions) == 0 {
		return []string{"  " + ansiGray + "No accounts connected yet." + ansiReset, ""}
	}
	names := make([]string, len(subscriptions))
	width := 0
	for i, subscription := range subscriptions {
		names[i] = subscription.Name
		if subscription.Label != nil && strings.TrimSpace(*subscription.Label) != "" {
			names[i] = *subscription.Label
		} else if email := subscription.SafeMetadata["account_email"]; email != "" {
			names[i] = email
		}
		width = max(width, len(names[i]))
	}
	lines := []string{}
	for i, subscription := range subscriptions {
		line := "  "
		if showProvider {
			line += fmt.Sprintf("%-11s  ", subscriptionProviderFor(subscription.OAuthProvider).name)
		}
		lines = append(lines, line+fmt.Sprintf("%-*s  %s", width, names[i], ansiGray+subscriptionStatus(subscription)+ansiReset))
	}
	return append(lines, "")
}

// subscriptionProviderFor names the provider of a stored subscription.
func subscriptionProviderFor(oauthProvider string) agentSubscriptionProvider {
	for _, provider := range subscriptionProviders {
		if provider.id == oauthProvider {
			return provider
		}
	}
	return agentSubscriptionProvider{id: oauthProvider, name: oauthProvider}
}
