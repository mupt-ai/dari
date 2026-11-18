package cli

import (
	"cmp"
	"context"
	"fmt"
	"io"
	"strings"
	"time"

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
	lines := []string{"  " + ansiGray + "•" + ansiReset + " " + subscriptionLabel(subscription, showProvider, 0)}
	for _, detail := range subscriptionDetailLines(subscription) {
		lines = append(lines, "  "+detail)
	}
	return lines
}

// subscriptionLabel is a subscription's provider and plan, padded to width so
// the names of a list line up, then its name.
func subscriptionLabel(subscription subscriptionCredential, showProvider bool, width int) string {
	if !showProvider {
		label := subscriptionName(subscription)
		if plan := subscription.SafeMetadata["plan"]; plan != "" {
			label += " " + ansiGray + "(" + plan + ")" + ansiReset
		}
		return label
	}
	kind := subscriptionKind(subscription)
	pad := strings.Repeat(" ", max(0, width-len([]rune(kind))))
	return kind + pad + "  " + subscriptionName(subscription)
}

// subscriptionKind is a subscription's provider with its plan, "ChatGPT (Pro)".
func subscriptionKind(subscription subscriptionCredential) string {
	kind := subscriptionProviderFor(subscription.OAuthProvider).name
	if plan := subscription.SafeMetadata["plan"]; plan != "" {
		kind += " (" + plan + ")"
	}
	return kind
}

// subscriptionDetailLines are a subscription's quota windows and models at
// their own limit, each a meter with its reset, then its renewal.
func subscriptionDetailLines(subscription subscriptionCredential) []string {
	type meter struct {
		label  string
		used   float64
		resets time.Time
	}
	meters := []meter{}
	now := time.Now()
	if subscription.Usage != nil {
		for _, window := range subscription.Usage.Windows {
			resets, err := time.Parse(time.RFC3339Nano, window.ResetsAt)
			if err == nil && resets.After(now) {
				meters = append(meters, meter{window.Label, window.Utilization, resets})
			}
		}
	}
	for _, hold := range activeModelHolds(subscription, now) {
		// A full Fable window already says its models are at their limit.
		if fableWindowFull(subscription) && strings.HasPrefix(hold.Model, "anthropic/claude-fable-") {
			continue
		}
		resets, _ := time.Parse(time.RFC3339Nano, hold.UnavailableUntil)
		meters = append(meters, meter{cmp.Or(hold.DisplayName, hold.Model), 1, resets})
	}
	// Every column starts at the same place: name, meter, use, reset.
	width, statusWidth := 0, len(usageLimitReached)
	for _, m := range meters {
		width = max(width, len([]rune(m.label)))
	}
	lines := []string{}
	for _, m := range meters {
		label := m.label + strings.Repeat(" ", width-len([]rune(m.label)))
		filled := min(usageMeterWidth, int(m.used*usageMeterWidth+0.5))
		bar := ansiReset + strings.Repeat("▰", filled) + ansiGray + strings.Repeat("▱", usageMeterWidth-filled)
		used := fmt.Sprintf("%.0f%% used", m.used*100)
		used += strings.Repeat(" ", statusWidth-len(used))
		if m.used >= 1 {
			bar = ansiRed + strings.Repeat("▰", usageMeterWidth) + ansiGray
			used = ansiRed + usageLimitReached + ansiGray
		}
		lines = append(lines, "  "+ansiGray+label+"  "+bar+"  "+used+"  resets "+usageResetTime(m.resets)+ansiReset)
	}
	if renews, err := time.Parse(time.RFC3339, subscription.SafeMetadata["renews_at"]); err == nil && renews.After(now) {
		// The plan's billing renewal, apart from its usage windows' resets.
		lines = append(lines, "  "+ansiGray+"Plan renews "+renews.Local().Format("Jan 2")+ansiReset)
	}
	return lines
}

const usageMeterWidth = 10

// subscriptionProviderFor names the provider of a stored subscription.
func subscriptionProviderFor(oauthProvider string) agentSubscriptionProvider {
	for _, provider := range subscriptionProviders {
		if provider.id == oauthProvider {
			return provider
		}
	}
	return agentSubscriptionProvider{id: oauthProvider, name: oauthProvider}
}
