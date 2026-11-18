package cli

import (
	"context"
	"io"
	"strings"

	"github.com/mupt-ai/dari/internal/api"
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
	museSubscription = agentSubscriptionProvider{"meta_muse", "Muse Code", "meta", "Meta", true, "https://accountscenter.meta.com/muse_code/", "https://accountscenter.meta.com/muse_code/"}
	// OpenCode Go signs in with the OpenCode Console device flow that
	// `opencode auth login` runs.
	opencodeGoSubscription = agentSubscriptionProvider{"opencode_go", "OpenCode Go", "opencode-go", "OpenCode", true, "https://opencode.ai/go", "https://opencode.ai/console"}
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

// agentSubscriptionProviders are the subscriptions an agent can use, its own
// first.
func agentSubscriptionProviders(agent string) []agentSubscriptionProvider {
	return agentSetups[agent].subscriptions
}

// subscriptionLines is one subscription: its provider, name, and plan, then
// a line for each quota window, each model at its own limit, and its renewal.
func subscriptionLines(subscription subscriptionCredential, showProvider bool) []string {
	lines := []string{"  " + ansiGray + "•" + ansiReset + " " + subscriptionLabel(subscription, showProvider)}
	for _, detail := range subscriptionDetailLines(subscription) {
		lines = append(lines, "  "+detail)
	}
	return lines
}

// subscriptionLabel is a subscription's provider, name, and plan on one line.
func subscriptionLabel(subscription subscriptionCredential, showProvider bool) string {
	label := ""
	if showProvider {
		label += subscriptionProviderFor(subscription.OAuthProvider).name + "  "
	}
	label += subscriptionName(subscription)
	if plan := subscription.SafeMetadata["plan"]; plan != "" {
		label += "  " + ansiGray + plan + ansiReset
	}
	return label
}

// subscriptionDetailLines are a subscription's usage, model limits, and
// renewal, one gray line each.
func subscriptionDetailLines(subscription subscriptionCredential) []string {
	lines := []string{}
	for _, detail := range subscriptionDetails(subscription) {
		detail = strings.Replace(detail, usageLimitReached, ansiRed+usageLimitReached+ansiGray, 1)
		lines = append(lines, "  "+ansiGray+"› "+detail+ansiReset)
	}
	return lines
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
