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
	columns := subscriptionColumnsFor([]subscriptionCredential{subscription})
	lines := []string{"  " + ansiGray + "•" + ansiReset + " " + subscriptionLabel(subscription, showProvider, columns)}
	for _, detail := range subscriptionDetailLines(subscription, columns) {
		lines = append(lines, "  "+detail)
	}
	return lines
}

// subscriptionColumns lays out a list of subscriptions: the provider and plan
// columns, and where each name and each meter's use start, the same place.
type subscriptionColumns struct {
	provider, plan, name int
}

func subscriptionColumnsFor(subscriptions []subscriptionCredential) subscriptionColumns {
	columns := subscriptionColumns{}
	meterLabel := 0
	for _, subscription := range subscriptions {
		columns.provider = max(columns.provider, len([]rune(subscriptionProviderFor(subscription.OAuthProvider).name)))
		columns.plan = max(columns.plan, len([]rune(subscriptionPlan(subscription))))
		for _, m := range subscriptionMeters(subscription) {
			meterLabel = max(meterLabel, len([]rune(m.label)))
		}
	}
	kind := columns.provider
	if columns.plan > 0 {
		kind += 1 + columns.plan
	}
	columns.name = max(kind+2, meterLabel+2+usageMeterWidth+2)
	return columns
}

// subscriptionPlan is the plan in parentheses, "(Pro)", or empty.
func subscriptionPlan(subscription subscriptionCredential) string {
	if plan := subscription.SafeMetadata["plan"]; plan != "" {
		return "(" + plan + ")"
	}
	return ""
}

// subscriptionLabel is a subscription's provider, plan, and name, each in its
// column.
func subscriptionLabel(subscription subscriptionCredential, showProvider bool, columns subscriptionColumns) string {
	if !showProvider {
		label := subscriptionName(subscription)
		if plan := subscriptionPlan(subscription); plan != "" {
			label += " " + ansiGray + plan + ansiReset
		}
		return label
	}
	kind := padRight(subscriptionProviderFor(subscription.OAuthProvider).name, columns.provider)
	if columns.plan > 0 {
		kind += " " + padRight(subscriptionPlan(subscription), columns.plan)
	}
	return padRight(kind, columns.name) + subscriptionName(subscription)
}

func padRight(text string, width int) string {
	return text + strings.Repeat(" ", max(0, width-len([]rune(text))))
}

type usageMeter struct {
	label  string
	used   float64
	resets time.Time
}

// subscriptionMeters are a subscription's running quota windows and models
// at their own limit.
func subscriptionMeters(subscription subscriptionCredential) []usageMeter {
	meters := []usageMeter{}
	now := time.Now()
	if subscription.Usage != nil {
		for _, window := range subscription.Usage.Windows {
			resets, err := time.Parse(time.RFC3339Nano, window.ResetsAt)
			if err == nil && resets.After(now) {
				meters = append(meters, usageMeter{window.Label, window.Utilization, resets})
			}
		}
	}
	for _, hold := range activeModelHolds(subscription, now) {
		// A full Fable window already says its models are at their limit.
		if fableWindowFull(subscription) && strings.HasPrefix(hold.Model, "anthropic/claude-fable-") {
			continue
		}
		resets, _ := time.Parse(time.RFC3339Nano, hold.UnavailableUntil)
		meters = append(meters, usageMeter{cmp.Or(hold.DisplayName, hold.Model), 1, resets})
	}
	return meters
}

// subscriptionDetailLines are a subscription's meters, their use starting
// in the name column, then its renewal.
func subscriptionDetailLines(subscription subscriptionCredential, columns subscriptionColumns) []string {
	labelWidth := columns.name - 2 - usageMeterWidth - 2
	lines := []string{}
	for _, m := range subscriptionMeters(subscription) {
		filled := min(usageMeterWidth, int(m.used*usageMeterWidth+0.5))
		bar := ansiReset + strings.Repeat("▰", filled) + ansiGray + strings.Repeat("▱", usageMeterWidth-filled)
		used := padRight(fmt.Sprintf("%.0f%% used", m.used*100), len(usageLimitReached))
		if m.used >= 1 {
			bar = ansiRed + strings.Repeat("▰", usageMeterWidth) + ansiGray
			used = ansiRed + usageLimitReached + ansiGray
		}
		lines = append(lines, "  "+ansiGray+padRight(m.label, labelWidth)+"  "+bar+"  "+used+"  resets "+usageResetTime(m.resets)+ansiReset)
	}
	if renews, err := time.Parse(time.RFC3339, subscription.SafeMetadata["renews_at"]); err == nil && renews.After(time.Now()) {
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
