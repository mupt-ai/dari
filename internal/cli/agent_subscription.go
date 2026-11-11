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
	"time"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/auth"
)

// routerProvider is the router provider whose models the subscription serves,
// and vendor the company whose sign-in connects it. A device-code sign-in shows
// a code to enter at the vendor; the others paste back the vendor's code.
// buyURL is the vendor's plan page, where another account can subscribe, and
// billingURL where the signed-in account changes or cancels its plan.
type agentSubscriptionProvider struct {
	id, name, routerProvider, vendor string
	deviceCode                       bool
	buyURL, billingURL               string
}

var (
	claudeSubscription = agentSubscriptionProvider{"anthropic_claude_code", "Claude Code", "anthropic", "Anthropic", false, "https://claude.ai/upgrade", "https://claude.ai/settings/billing"}
	codexSubscription  = agentSubscriptionProvider{"openai_codex", "ChatGPT", "openai", "OpenAI", true, "https://chatgpt.com/#pricing", "https://chatgpt.com/#settings/Account"}
	// Muse Code subscriptions serve only Muse Code.
	museSubscription = agentSubscriptionProvider{"meta_muse", "Muse Code", "meta", "Meta", true, "", ""}
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
		// Buying needs a new account at the vendor; managing opens the plan
		// settings of the account signed in there.
		buys := map[int]agentSubscriptionProvider{}
		manages := map[int]agentSubscriptionProvider{}
		for _, provider := range providers {
			if provider.buyURL == "" {
				continue
			}
			label := "Buy a " + provider.name + " subscription"
			if len(subscriptions) > 0 {
				label = "Buy another " + provider.name + " subscription"
			}
			buys[len(options)] = provider
			options = append(options, agentChoiceOption{label: label})
			if slices.ContainsFunc(subscriptions, func(c subscriptionCredential) bool { return c.OAuthProvider == provider.id }) {
				manages[len(options)] = provider
				options = append(options, agentChoiceOption{label: "Manage a " + provider.name + " plan"})
			}
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
		if provider, manage := manages[choice]; manage {
			if openAgentBrowser(provider.billingURL) {
				fmt.Fprintf(stderr, "Opened %s plan settings. Sign in with the account to manage if another is open:\n  %s\n", provider.vendor, provider.billingURL)
			} else {
				fmt.Fprintf(stderr, "Manage the plan, signed in with that account, at:\n  %s\n", provider.billingURL)
			}
			continue
		}
		if provider, buy := buys[choice]; buy {
			bought, err := buyAgentSubscription(stdin, stderr, provider)
			if err != nil {
				return added, keysAdded, err
			}
			if !bought {
				continue
			}
			if err := connectAgentPersonalSubscription(ctx, provider, client, stdin, stderr, ""); err != nil {
				return added, keysAdded, err
			}
			added++
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

// buyAgentSubscription opens the vendor's plan page, where the user signs up
// with another account and subscribes. It reports whether they subscribed and
// want to connect the new account now.
func buyAgentSubscription(stdin io.Reader, stderr io.Writer, provider agentSubscriptionProvider) (bool, error) {
	details := []string{"  " + ansiGray + "Each " + provider.name + " subscription needs its own " + provider.vendor + " account." + ansiReset}
	if openAgentBrowser(provider.buyURL) {
		details = append(details, "  "+ansiGray+"Opened "+provider.vendor+" in your browser. If it didn't open, visit:"+ansiReset)
	} else {
		details = append(details, "  "+ansiGray+"Subscribe at:"+ansiReset)
	}
	details = append(details, agentURLLines(provider.buyURL, 0)...)
	details = append(details, "  "+ansiGray+"Sign in with a new account, subscribe, then connect it here."+ansiReset, "")
	choice, err := runAgentChoiceTUI(stdin, stderr, "Buy a "+provider.name+" subscription", details, []agentChoiceOption{
		{label: "I've subscribed, connect it"},
		{label: "Back"},
	})
	return choice == 0, err
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
		lines = append(lines, line+fmt.Sprintf("%-*s  %s", width, names[i], ansiGray+strings.Join(subscriptionDetails(subscription), " · ")+ansiReset))
	}
	return append(lines, "")
}

// subscriptionDetails is a subscription's status, then its plan, how much of
// its current window is used, and its renewal, when the provider reports them.
func subscriptionDetails(subscription subscriptionCredential) []string {
	details := []string{subscriptionStatus(subscription)}
	if plan := subscription.SafeMetadata["plan"]; plan != "" {
		details = append(details, plan)
	}
	if usage := subscription.Usage; usage != nil {
		if resets, err := time.Parse(time.RFC3339Nano, usage.ResetsAt); err == nil && resets.After(time.Now()) {
			details = append(details, fmt.Sprintf("%.0f%% used, resets %s", usage.Utilization*100, usageResetTime(resets)))
		}
	}
	if renews, err := time.Parse(time.RFC3339, subscription.SafeMetadata["renews_at"]); err == nil && renews.After(time.Now()) {
		details = append(details, "renews "+renews.Local().Format("Jan 2"))
	}
	return details
}

// usageResetTime is the clock time a window resets, with its date when it is
// not today.
func usageResetTime(resets time.Time) string {
	local := resets.Local()
	if local.Format("2006-01-02") == time.Now().Format("2006-01-02") {
		return local.Format("3:04pm")
	}
	return local.Format("Jan 2 3:04pm")
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
