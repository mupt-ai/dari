package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/auth"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		root.AddCommand(&cobra.Command{
			Use:   "accounts",
			Short: "Manage your subscriptions, API keys, and auto-routing, hosted or on a gateway",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return runAccounts(cmd.Context(), gf, cmd.InOrStdin(), cmd.ErrOrStderr())
			},
		})
	})
}

// runAccounts opens the Accounts page wherever coding agents route: the
// hosted Dari API, or the local or self-hosted gateway.
func runAccounts(ctx context.Context, gf *globalFlags, stdin io.Reader, stderr io.Writer) error {
	if !agentInputIsTerminal(stdin) {
		return errors.New("the Accounts page needs an interactive terminal; use `dari credentials subscription` instead")
	}
	gw, err := agentGateway(ctx, stdin, stderr)
	if err != nil {
		return err
	}
	if gw != nil {
		if err := gw.ensure(ctx, stderr); err != nil {
			return err
		}
		_, err := accountsPage{client: api.New(gw.url).WithBearer(gw.key), providers: allSubscriptionProviders, gw: gw}.run(ctx, stdin, stderr)
		return err
	}
	apiURL, err := gf.resolveAPIURL()
	if err != nil {
		return err
	}
	if _, err := agentKeyScope(ctx, apiURL, stdin, stderr); err != nil {
		return err
	}
	client, err := auth.OrgKeyClient(apiURL)
	if err != nil {
		return err
	}
	result, pageErr := accountsPage{client: client, providers: allSubscriptionProviders, hosted: true}.run(ctx, stdin, stderr)
	// Accounts connected before an error are stored, so route through them
	// before reporting it.
	if err := applyHostedAccounts(ctx, client, result, stderr); err != nil {
		return err
	}
	return pageErr
}

// applyHostedAccounts puts newly connected accounts to work. A new
// subscription serves the default router's models from its provider; Claude
// Code's and Codex's own routers pick theirs up on their next launch. New API
// keys take over the default router's and agent routers' models they serve.
func applyHostedAccounts(ctx context.Context, client *api.Client, result accountsResult, stderr io.Writer) error {
	if len(result.added) == 0 && result.keysAdded == 0 {
		return nil
	}
	routers, err := listAgentRouters(ctx, client)
	if err != nil {
		return err
	}
	if len(result.added) > 0 {
		if router, ok := findAgentRouter(routers, func(router agentRouter) bool { return router.IsDefault }); ok {
			if err := setAgentRouterSubscription(ctx, client, router, result.added, true); err != nil {
				return err
			}
		}
	}
	if result.keysAdded > 0 {
		for _, router := range routers {
			if router.IsDefault || len(router.CodingAgents) > 0 {
				if err := applyAgentProviderKeys(ctx, client, router.ID, stderr); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// accountsPage is the Accounts page. Hosted Dari and gateways serve the same
// subscription API, so subscriptions work the same on both; API keys and
// auto-routing are organization credentials and a plan when hosted, and
// settings of a local gateway.
type accountsPage struct {
	client    *api.Client
	providers []agentSubscriptionProvider
	hosted    bool
	// gw is the gateway the page manages, or nil when hosted.
	gw *gatewayConfig
	// onboarding pages leave with Dari managed billing while nothing is
	// connected.
	onboarding bool
}

type accountsResult struct {
	// added are the providers whose subscriptions the page connected.
	added     []agentSubscriptionProvider
	keysAdded int
}

func (page accountsPage) run(ctx context.Context, stdin io.Reader, stderr io.Writer) (accountsResult, error) {
	result := accountsResult{}
	for {
		var raw json.RawMessage
		if err := page.client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials", nil, &raw); err != nil {
			return result, api.HumanError(err)
		}
		var listed struct {
			Credentials []subscriptionCredential `json:"credentials"`
		}
		if err := json.Unmarshal(raw, &listed); err != nil {
			return result, err
		}
		subscriptions := slices.DeleteFunc(personalSubscriptions(listed.Credentials), func(c subscriptionCredential) bool {
			return !slices.ContainsFunc(page.providers, func(p agentSubscriptionProvider) bool { return p.id == c.OAuthProvider })
		})
		keys := map[string]agentProviderCredential{}
		if page.hosted {
			var listedKeys struct {
				Credentials []agentProviderCredential `json:"credentials"`
			}
			if err := json.Unmarshal(raw, &listedKeys); err != nil {
				return result, err
			}
			keys = agentAPIKeys(listedKeys.Credentials)
		}
		lines := agentAccountLines(subscriptions, keys, len(page.providers) > 1)
		if page.local() {
			for _, key := range localProviderKeys {
				if page.gw.settings.ProviderKeys[key.env] != "" {
					lines = slices.Insert(lines, len(lines)-1, "  "+key.name+"  "+ansiGray+"API key"+ansiReset)
				}
			}
		}
		connected := len(subscriptions) > 0 || len(keys) > 0

		options := []agentChoiceOption{}
		actions := []func() (bool, error){}
		add := func(option agentChoiceOption, action func() (bool, error)) {
			options = append(options, option)
			actions = append(actions, action)
		}
		leave := func() (bool, error) { return true, nil }
		finish := agentChoiceOption{label: "Done"}
		if page.onboarding {
			finish = agentChoiceOption{label: "Continue", done: fmt.Sprintf("Accounts: %d connected", len(subscriptions)+len(keys))}
			if !connected {
				finish = agentChoiceOption{label: "Use Dari managed billing", done: "Using Dari managed billing"}
			}
		}
		if !page.onboarding || connected {
			add(finish, leave)
		}
		for _, subscription := range subscriptions {
			add(agentChoiceOption{label: subscriptionName(subscription)}, func() (bool, error) {
				return false, page.manageSubscription(ctx, subscription, stdin, stderr)
			})
		}
		add(agentChoiceOption{label: "Add a subscription"}, func() (bool, error) {
			provider, ok, err := page.addSubscription(ctx, subscriptions, stdin, stderr)
			if ok && !slices.Contains(result.added, provider) {
				result.added = append(result.added, provider)
			}
			return false, err
		})
		switch {
		case page.hosted:
			add(agentChoiceOption{label: "Add an API key"}, func() (bool, error) {
				saved, err := connectAgentAPIKey(ctx, page.client, stdin, stderr, keys)
				if saved {
					result.keysAdded++
				}
				return false, err
			})
			routing, err := autoroutingAllowed(ctx, page.client)
			if err != nil {
				return result, err
			}
			if !routing {
				add(agentChoiceOption{label: "Get auto-routing"}, func() (bool, error) {
					_, err := getAutorouting(ctx, page.client, stdin, stderr)
					return false, err
				})
			}
		case page.local():
			add(agentChoiceOption{label: "Add an API key"}, func() (bool, error) {
				return false, page.addLocalKey(ctx, stdin, stderr)
			})
			label := "Add a Dari API key for auto-routing"
			if page.gw.settings.AutoRoutingKey != "" {
				label = "Replace the auto-routing Dari API key"
			}
			add(agentChoiceOption{label: label}, func() (bool, error) {
				_, err := runAgentSecretInputTUI(stdin, stderr, "Dari API key", nil, func(value string) error {
					page.gw.settings.AutoRoutingKey = value
					return saveLocalGateway(ctx, page.gw, stderr)
				})
				return false, err
			})
		}
		if page.onboarding && !connected {
			add(finish, leave)
		}

		choice, err := runAgentChoiceTUI(stdin, stderr, "Accounts", lines, options)
		if err != nil {
			return result, err
		}
		done, err := actions[choice]()
		if done || err != nil {
			return result, err
		}
	}
}

func (page accountsPage) local() bool { return page.gw != nil && page.gw.local }

// addSubscription connects a provider's account, or buys another one first.
// It reports the provider when one was connected.
func (page accountsPage) addSubscription(ctx context.Context, subscriptions []subscriptionCredential, stdin io.Reader, stderr io.Writer) (agentSubscriptionProvider, bool, error) {
	options := []agentChoiceOption{}
	type choice struct {
		provider agentSubscriptionProvider
		buy      bool
	}
	choices := []choice{}
	for _, provider := range page.providers {
		label := "Connect a " + provider.name + " account"
		if slices.ContainsFunc(subscriptions, func(c subscriptionCredential) bool { return c.OAuthProvider == provider.id }) {
			label = "Connect another " + provider.name + " account"
		}
		options = append(options, agentChoiceOption{label: label})
		choices = append(choices, choice{provider: provider})
	}
	for _, provider := range page.providers {
		if provider.buyURL == "" {
			continue
		}
		label := "Buy a " + provider.name + " subscription"
		if slices.ContainsFunc(subscriptions, func(c subscriptionCredential) bool { return c.OAuthProvider == provider.id }) {
			label = "Buy another " + provider.name + " subscription"
		}
		options = append(options, agentChoiceOption{label: label})
		choices = append(choices, choice{provider: provider, buy: true})
	}
	options = append(options, agentChoiceOption{label: "Back"})
	picked, err := runAgentChoiceTUI(stdin, stderr, "Add a subscription", nil, options)
	if err != nil || picked == len(choices) {
		return agentSubscriptionProvider{}, false, err
	}
	selected := choices[picked]
	if selected.buy {
		bought, err := buyAgentSubscription(stdin, stderr, selected.provider)
		if err != nil || !bought {
			return agentSubscriptionProvider{}, false, err
		}
	}
	if err := connectAgentPersonalSubscription(ctx, selected.provider, page.client, stdin, stderr, ""); err != nil {
		return agentSubscriptionProvider{}, false, err
	}
	return selected.provider, true, nil
}

// manageSubscription is one subscription's page: its plan at the vendor, its
// name, its connection, a usage-limit hold, and banked Codex resets.
func (page accountsPage) manageSubscription(ctx context.Context, subscription subscriptionCredential, stdin io.Reader, stderr io.Writer) error {
	name := subscriptionName(subscription)
	provider := subscriptionProviderFor(subscription.OAuthProvider)
	path := "/v1/organizations/current/credentials/" + url.PathEscape(subscription.Name)
	options := []agentChoiceOption{}
	actions := []func() error{}
	add := func(label string, action func() error) {
		options = append(options, agentChoiceOption{label: label})
		actions = append(actions, action)
	}
	if provider.billingURL != "" {
		add("Manage plan at "+provider.vendor, func() error {
			if openAgentBrowser(provider.billingURL) {
				agentStep(stderr, "Opened "+provider.vendor+"; sign in as "+name+" if another account is open")
			} else {
				agentPrintln(stderr, "Manage the plan, signed in as "+name+", at:\n  "+provider.billingURL)
			}
			return nil
		})
	}
	add("Rename", func() error {
		_, err := runAgentTextInputTUI(stdin, stderr, "Rename "+name, []string{"  " + ansiGray + "Leave empty to show the account email." + ansiReset, ""}, name, func(label string) error {
			var updated map[string]any
			return api.HumanError(page.client.Do(ctx, http.MethodPut, path+"/label", map[string]string{"label": strings.TrimSpace(label)}, &updated))
		})
		return err
	})
	add("Reconnect", func() error {
		return connectAgentPersonalSubscription(ctx, provider, page.client, stdin, stderr, subscription.Name)
	})
	if subscriptionStatus(subscription) == "held" {
		add("Mark available", func() error {
			var updated map[string]any
			return api.HumanError(page.client.Do(ctx, http.MethodPost, path+"/mark-available", nil, &updated))
		})
	}
	if page.hosted && provider == codexSubscription {
		label := "Use banked resets when every ChatGPT subscription is exhausted"
		if subscription.AutoRedeemResets {
			label = "Stop using banked resets"
		}
		add(label, func() error {
			var updated map[string]any
			return api.HumanError(page.client.Do(ctx, http.MethodPut, path+"/auto-reset", map[string]bool{"enabled": !subscription.AutoRedeemResets}, &updated))
		})
	}
	add("Disconnect", func() error {
		confirm, err := runAgentChoiceTUI(stdin, stderr, "Disconnect "+name+"?", nil, []agentChoiceOption{{label: "Keep it"}, {label: "Disconnect", done: name + " disconnected"}})
		if err != nil || confirm == 0 {
			return err
		}
		return api.HumanError(page.client.Do(ctx, http.MethodDelete, path+"?scope=user", nil, nil))
	})
	options = append(options, agentChoiceOption{label: "Back"})
	choice, err := runAgentChoiceTUI(stdin, stderr, name, agentSubscriptionLines([]subscriptionCredential{subscription}, true), options)
	if err != nil || choice == len(actions) {
		return err
	}
	return actions[choice]()
}

// addLocalKey saves a provider API key into the local gateway's settings.
func (page accountsPage) addLocalKey(ctx context.Context, stdin io.Reader, stderr io.Writer) error {
	options := []agentChoiceOption{}
	for _, key := range localProviderKeys {
		label := key.name
		if page.gw.settings.ProviderKeys[key.env] != "" {
			label += " (replace)"
		}
		options = append(options, agentChoiceOption{label: label})
	}
	options = append(options, agentChoiceOption{label: "Back"})
	choice, err := runAgentChoiceTUI(stdin, stderr, "Add an API key", nil, options)
	if err != nil || choice == len(localProviderKeys) {
		return err
	}
	key := localProviderKeys[choice]
	_, err = runAgentSecretInputTUI(stdin, stderr, key.name+" API key", nil, func(value string) error {
		if page.gw.settings.ProviderKeys == nil {
			page.gw.settings.ProviderKeys = map[string]string{}
		}
		page.gw.settings.ProviderKeys[key.env] = value
		return saveLocalGateway(ctx, page.gw, stderr)
	})
	return err
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

// subscriptionName is the user's name for a subscription, else its account
// email, else its credential name.
func subscriptionName(subscription subscriptionCredential) string {
	if subscription.Label != nil && strings.TrimSpace(*subscription.Label) != "" {
		return *subscription.Label
	}
	if email := subscription.SafeMetadata["account_email"]; email != "" {
		return email
	}
	return subscription.Name
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
