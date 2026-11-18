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
		cmd := &cobra.Command{
			Use:   "accounts",
			Short: "Manage your subscriptions, API keys, and auto-routing, hosted or on a gateway",
			Long: "With no subcommand, opens the Accounts page wherever coding agents route, which needs a terminal.\n" +
				"The subcommands work without one, for scripts and agents, and print JSON. `subscription`\n" +
				"works hosted or on a gateway; `provider` and `list` manage organization credentials on hosted Dari;\n" +
				"`auto-routing` sets the local gateway's Dari API key.",
			Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return runAccounts(cmd.Context(), gf, cmd.InOrStdin(), cmd.ErrOrStderr())
			},
		}
		cmd.AddCommand(
			newSubscriptionCredentialsCmd(gf),
			newProviderCredentialsCmd(gf),
			newCredentialsListCmd(gf),
			newAccountsAutoRoutingCmd(),
		)
		root.AddCommand(cmd)
	})
}

// newAccountsAutoRoutingCmd sets the Dari API key a local gateway routes with,
// as the Accounts page does.
func newAccountsAutoRoutingCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "auto-routing <dari-api-key|off>",
		Short: "Local gateway only: route with Dari's routing policy, using your Dari API key",
		Long: "Auto-routing picks the model for each request with Dari's routing policy. The local gateway calls it with a Dari API key.\n" +
			"A self-hosted gateway's operator sets DARI_AUTO_ROUTING_API_KEY on the server instead; hosted Dari includes it with the Autorouting plan.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			gw, err := localGateway()
			if err != nil {
				return err
			}
			gw.settings.AutoRoutingKey = strings.TrimSpace(args[0])
			if strings.EqualFold(gw.settings.AutoRoutingKey, "off") {
				gw.settings.AutoRoutingKey = ""
			}
			return saveLocalGateway(cmd.Context(), gw, cmd.ErrOrStderr())
		},
	}
}

// runAccounts opens the Accounts page wherever coding agents route: the
// hosted Dari API, or the local or self-hosted gateway.
func runAccounts(ctx context.Context, gf *globalFlags, stdin io.Reader, stderr io.Writer) error {
	if !agentInputIsTerminal(stdin) {
		return errors.New("the Accounts page needs an interactive terminal; use `dari accounts subscription` instead")
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
	// One alternate screen for every page, so going back never shows the
	// shell while the next page loads.
	if !agentScreen.held {
		holdAgentScreen()
		defer releaseAgentScreen()
	}
	result := accountsResult{}
	// reopen is the subscription whose page to show again once the list reloads.
	reopen := ""
	// The page reloads only after something may have changed; going back
	// shows the last listing at once.
	var raw json.RawMessage
	stale, routing := true, true
	resets := map[string]*resetsFetch{}
	for {
		if stale {
			// OpenCode Go reports plan usage only when asked.
			if err := page.client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials?refresh_usage=true", nil, &raw); err != nil {
				return result, api.HumanError(err)
			}
			if page.hosted {
				var err error
				if routing, err = autoroutingAllowed(ctx, page.client); err != nil {
					return result, err
				}
			}
			resets = map[string]*resetsFetch{}
			stale = false
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
		// Each subscription's banked resets load while the list shows, so its
		// page opens without waiting.
		if page.hosted {
			for _, subscription := range subscriptions {
				if p := subscriptionProviderFor(subscription.OAuthProvider); (p == codexSubscription || p == claudeSubscription) && resets[subscription.Name] == nil {
					resets[subscription.Name] = fetchSubscriptionResets(ctx, page.client, subscription.Name)
				}
			}
		}
		if i := slices.IndexFunc(subscriptions, func(c subscriptionCredential) bool { return c.Name == reopen }); i >= 0 {
			outcome, err := page.manageSubscription(ctx, subscriptions[i], resets[reopen], stdin, stderr)
			if err != nil {
				return result, err
			}
			stale = outcome != subscriptionPageBack
			if outcome == subscriptionPageActed {
				continue
			}
		}
		reopen = ""
		// changed is cleared by an action that only looked.
		changed := true
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
		// Each key is a page of its own: its name and how to remove it.
		type accountKey struct {
			name   string
			remove func() error
		}
		accountKeys := []accountKey{}
		for _, provider := range slices.Sorted(maps.Keys(keys)) {
			key := keys[provider]
			accountKeys = append(accountKeys, accountKey{cmp.Or(key.Label, key.Name, provider), func() error {
				return api.HumanError(page.client.Do(ctx, http.MethodDelete,
					"/v1/organizations/current/credentials/provider-credentials/"+url.PathEscape(key.ID), nil, nil))
			}})
		}
		if page.local() {
			for _, key := range localProviderKeys {
				if page.gw.settings.ProviderKeys[key.env] != "" {
					accountKeys = append(accountKeys, accountKey{key.name, func() error {
						delete(page.gw.settings.ProviderKeys, key.env)
						return saveLocalGateway(ctx, page.gw, stderr)
					}})
				}
			}
		}
		connected := len(subscriptions) > 0 || len(accountKeys) > 0
		var lines []string
		if len(subscriptions) == 0 && len(accountKeys) == 0 {
			lines = []string{"  " + ansiGray + "No accounts connected yet." + ansiReset}
		}

		options := []agentChoiceOption{}
		actions := []func() (bool, error){}
		add := func(option agentChoiceOption, action func() (bool, error)) {
			options = append(options, option)
			actions = append(actions, action)
		}
		leave := func() (bool, error) { return true, nil }
		finish := agentChoiceOption{label: "Done"}
		if page.onboarding {
			finish = agentChoiceOption{label: "Continue", done: fmt.Sprintf("Accounts: %d connected", len(subscriptions)+len(accountKeys))}
			if !connected {
				finish = agentChoiceOption{label: "Use Dari managed billing", done: "Using Dari managed billing"}
			}
		}
		// The accounts themselves come first, each numbered where it is shown,
		// in columns shared by the whole list.
		columns := subscriptionColumnsFor(subscriptions)
		for i, subscription := range subscriptions {
			option := agentChoiceOption{
				label:   subscriptionLabel(subscription, len(page.providers) > 1, columns),
				details: subscriptionDetailLines(subscription, columns),
				boxed:   true,
			}
			if i == 0 {
				option.heading = "Subscriptions"
			}
			// A blank line between subscriptions keeps each one's meters with it.
			option.gap = i > 0
			add(option, func() (bool, error) {
				outcome, err := page.manageSubscription(ctx, subscription, resets[subscription.Name], stdin, stderr)
				changed = outcome != subscriptionPageBack
				if outcome == subscriptionPageActed {
					reopen = subscription.Name
				}
				return false, err
			})
		}
		for i, key := range accountKeys {
			option := agentChoiceOption{label: key.name}
			if i == 0 {
				option.heading = "API Keys"
			}
			add(option, func() (bool, error) {
				removed, err := manageAPIKey(stdin, stderr, key.name, key.remove)
				changed = removed
				return false, err
			})
		}
		finish.heading = "Settings"
		if !page.onboarding || connected {
			add(finish, leave)
		}
		addSubscription := agentChoiceOption{label: "Add a subscription"}
		if page.onboarding && !connected {
			addSubscription.heading = "Settings"
		}
		add(addSubscription, func() (bool, error) {
			provider, ok, err := page.addSubscription(ctx, subscriptions, stdin, stderr)
			changed = ok
			if ok && !slices.Contains(result.added, provider) {
				result.added = append(result.added, provider)
			}
			return false, err
		})
		switch {
		case page.hosted:
			add(agentChoiceOption{label: "Add an API key"}, func() (bool, error) {
				saved, err := connectAgentAPIKey(ctx, page.client, stdin, stderr, keys)
				changed = saved
				if saved {
					result.keysAdded++
				}
				return false, err
			})
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

		// The page is a command's first page, which esc closes; in onboarding
		// it is a step of setup, which esc leaves.
		choose := runAgentRootChoiceTUI
		if page.onboarding {
			choose = runAgentChoicePageClosing
		}
		choice, err := choose(stdin, stderr, "", lines, options)
		if errors.Is(err, errAgentChoiceCanceled) && !page.onboarding {
			return result, nil
		}
		if err != nil {
			return result, err
		}
		done, err := actions[choice]()
		stale = stale || changed
		// Esc on a page this one opened comes back here.
		if errors.Is(err, errAgentChoiceCanceled) {
			continue
		}
		if done || err != nil {
			return result, err
		}
	}
}

func (page accountsPage) local() bool { return page.gw != nil && page.gw.local }

// addSubscription connects a provider's account, or buys another one first.
// It reports the provider when one was connected.
func (page accountsPage) addSubscription(ctx context.Context, subscriptions []subscriptionCredential, stdin io.Reader, stderr io.Writer) (agentSubscriptionProvider, bool, error) {
	// Two groups, connecting an account and buying one, each listing the
	// providers by name.
	options := []agentChoiceOption{}
	type choice struct {
		provider agentSubscriptionProvider
		buy      bool
	}
	choices := []choice{}
	for i, provider := range page.providers {
		option := agentChoiceOption{label: provider.name}
		if i == 0 {
			option.heading = "Connect an Account"
		}
		if slices.ContainsFunc(subscriptions, func(c subscriptionCredential) bool { return c.OAuthProvider == provider.id }) {
			option.label += "  " + ansiGray + "another account" + ansiReset
		}
		options = append(options, option)
		choices = append(choices, choice{provider: provider})
	}
	first := true
	for _, provider := range page.providers {
		if provider.buyURL == "" {
			continue
		}
		option := agentChoiceOption{label: provider.name}
		if first {
			option.heading, first = "Buy a Subscription", false
		}
		options = append(options, option)
		choices = append(choices, choice{provider: provider, buy: true})
	}
	options = append(options, agentChoiceOption{label: "Back", gap: true})
	picked, err := runAgentChoiceTUI(stdin, stderr, "", nil, options)
	if errors.Is(err, errAgentChoiceCanceled) {
		return agentSubscriptionProvider{}, false, nil
	}
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

// manageSubscription is one subscription's page: its usage in a box like the
// list's, its banked resets to use, and its settings. It shows itself again
// after anything that changed nothing, and otherwise reports how it was left.
func (page accountsPage) manageSubscription(ctx context.Context, subscription subscriptionCredential, prefetched *resetsFetch, stdin io.Reader, stderr io.Writer) (subscriptionPageOutcome, error) {
	name := subscriptionName(subscription)
	provider := subscriptionProviderFor(subscription.OAuthProvider)
	path := "/v1/organizations/current/credentials/" + url.PathEscape(subscription.Name)
	resettable := page.hosted && (provider == codexSubscription || provider == claudeSubscription)
	var resets []subscriptionReset
	var resetsErr error
	if resettable {
		if prefetched == nil {
			prefetched = fetchSubscriptionResets(ctx, page.client, subscription.Name)
		}
		resets, resetsErr = prefetched.wait()
	}
	columns := subscriptionColumnsFor([]subscriptionCredential{subscription})
	rows := []string{subscriptionLabel(subscription, true, columns)}
	// Without a number before the name, the meters start where it does.
	for _, detail := range subscriptionDetailLines(subscription, columns) {
		rows = append(rows, strings.TrimPrefix(detail, "  "))
	}
	details := []string{}
	for _, line := range agentBox(rows, 0, ansiGray) {
		details = append(details, "  "+line)
	}
	if resettable && resetsErr != nil {
		details = append(details, "", "  "+ansiGray+"Couldn't read banked resets: "+resetsErr.Error()+ansiReset)
	} else if resettable && len(resets) == 0 {
		details = append(details, "", "  "+ansiGray+"No banked resets"+ansiReset)
	}

	for {
		options := []agentChoiceOption{}
		// Each action reports whether it changed anything.
		actions := []func() (bool, error){}
		add := func(option agentChoiceOption, action func() (bool, error)) {
			options = append(options, option)
			actions = append(actions, action)
		}
		// Each reset is chosen where it is listed, its expiry beside it.
		labelWidth := 0
		for _, reset := range resets {
			labelWidth = max(labelWidth, len([]rune(reset.Label)))
		}
		for i, reset := range resets {
			note := strings.TrimPrefix(resetExpiry(reset), " · ")
			if !reset.Usable {
				note = strings.TrimPrefix(note+" · not usable yet", " · ")
			}
			option := agentChoiceOption{label: padRight(reset.Label, labelWidth) + "  " + ansiGray + note + ansiReset}
			if i == 0 {
				option.heading = fmt.Sprintf("Banked Resets (%d)", len(resets))
			}
			add(option, func() (bool, error) {
				return page.useReset(ctx, subscription, reset, stdin, stderr)
			})
		}
		settings := len(options)
		if provider.billingURL != "" {
			add(agentChoiceOption{label: "Manage plan at " + provider.vendor}, func() (bool, error) {
				if openAgentBrowser(provider.billingURL) {
					agentStep(stderr, "Opened "+provider.vendor+"; sign in as "+name+" if another account is open")
				} else {
					agentPrintln(stderr, "Manage the plan, signed in as "+name+", at:\n  "+provider.billingURL)
				}
				return false, nil
			})
		}
		add(agentChoiceOption{label: "Rename"}, func() (bool, error) {
			return runAgentTextInputTUI(stdin, stderr, "Rename "+name, []string{"  " + ansiGray + "Leave empty to show the account email." + ansiReset, ""}, name, func(label string) error {
				var updated map[string]any
				return api.HumanError(page.client.Do(ctx, http.MethodPut, path+"/label", map[string]string{"label": strings.TrimSpace(label)}, &updated))
			})
		})
		add(agentChoiceOption{label: "Reconnect"}, func() (bool, error) {
			err := connectAgentPersonalSubscription(ctx, provider, page.client, stdin, stderr, subscription.Name)
			return err == nil, err
		})
		if subscriptionStatus(subscription) == "held" || len(activeModelHolds(subscription, time.Now())) > 0 {
			add(agentChoiceOption{label: "Mark available"}, func() (bool, error) {
				var updated map[string]any
				return true, api.HumanError(page.client.Do(ctx, http.MethodPost, path+"/mark-available", nil, &updated))
			})
		}
		if resettable {
			label := "Use banked resets when every " + provider.name + " subscription is exhausted"
			if subscription.AutoRedeemResets {
				label = "Stop using banked resets"
			}
			add(agentChoiceOption{label: label}, func() (bool, error) {
				var updated map[string]any
				return true, api.HumanError(page.client.Do(ctx, http.MethodPut, path+"/auto-reset", map[string]bool{"enabled": !subscription.AutoRedeemResets}, &updated))
			})
		}
		disconnected := false
		add(agentChoiceOption{label: "Disconnect"}, func() (bool, error) {
			confirm, err := runAgentChoiceTUI(stdin, stderr, "Disconnect "+name+"?", nil, []agentChoiceOption{{label: "Keep it"}, {label: "Disconnect", done: name + " disconnected"}})
			if err != nil || confirm == 0 {
				return false, err
			}
			disconnected = true
			return true, api.HumanError(page.client.Do(ctx, http.MethodDelete, path+"?scope=user", nil, nil))
		})
		options[settings].heading = "Settings"
		options = append(options, agentChoiceOption{label: "Back"})

		choice, err := runAgentChoiceTUI(stdin, stderr, "", details, options)
		if errors.Is(err, errAgentChoiceCanceled) || (err == nil && choice == len(actions)) {
			return subscriptionPageBack, nil
		}
		if err != nil {
			return subscriptionPageBack, err
		}
		changed, err := actions[choice]()
		if errors.Is(err, errAgentChoiceCanceled) {
			changed, err = false, nil
		}
		switch {
		case err != nil:
			return subscriptionPageActed, err
		case disconnected:
			return subscriptionPageLeft, nil
		case changed:
			return subscriptionPageActed, nil
		}
	}
}

// subscriptionPageOutcome is how a subscription's page was left.
type subscriptionPageOutcome int

const (
	// subscriptionPageBack changed nothing.
	subscriptionPageBack subscriptionPageOutcome = iota
	// subscriptionPageActed may have changed the subscription; its page shows
	// again, reloaded.
	subscriptionPageActed
	// subscriptionPageLeft disconnected it.
	subscriptionPageLeft
)

// resetsFetch is a subscription's banked resets, loading in the background.
type resetsFetch struct {
	done   chan struct{}
	resets []subscriptionReset
	err    error
}

func fetchSubscriptionResets(ctx context.Context, client *api.Client, name string) *resetsFetch {
	fetch := &resetsFetch{done: make(chan struct{})}
	go func() {
		defer close(fetch.done)
		fetch.resets, fetch.err = listSubscriptionResets(ctx, client, name)
	}()
	return fetch
}

func (fetch *resetsFetch) wait() ([]subscriptionReset, error) {
	<-fetch.done
	return fetch.resets, fetch.err
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

const usageLimitReached = "Limit reached"

// subscriptionDetails is one line each for how much of each quota window is
// used, as the API names and shows it, each model at its own limit, and the
// plan's renewal, when the provider reports them. A window at its limit says
// so; the others still show their headroom.
func subscriptionDetails(subscription subscriptionCredential) []string {
	details := []string{}
	if subscription.Usage != nil {
		for _, window := range subscription.Usage.Windows {
			resets, err := time.Parse(time.RFC3339Nano, window.ResetsAt)
			if err != nil || !resets.After(time.Now()) {
				continue
			}
			usage := fmt.Sprintf("%.0f%% used", window.Utilization*100)
			if window.Utilization >= 1 {
				usage = usageLimitReached
			}
			details = append(details, window.Label+" · "+usage+" · Resets "+usageResetTime(resets))
		}
	}
	for _, hold := range activeModelHolds(subscription, time.Now()) {
		// A full Fable window already says its models are at their limit.
		if fableWindowFull(subscription) && strings.HasPrefix(hold.Model, "anthropic/claude-fable-") {
			continue
		}
		resets, _ := time.Parse(time.RFC3339Nano, hold.UnavailableUntil)
		details = append(details, cmp.Or(hold.DisplayName, hold.Model)+" · "+usageLimitReached+" · Resets "+usageResetTime(resets))
	}
	if renews, err := time.Parse(time.RFC3339, subscription.SafeMetadata["renews_at"]); err == nil && renews.After(time.Now()) {
		details = append(details, "Renews "+renews.Local().Format("Jan 2"))
	}
	return details
}

// fableWindowFull reports whether the subscription's own Fable window is at
// its limit.
func fableWindowFull(subscription subscriptionCredential) bool {
	return subscription.Usage != nil && slices.ContainsFunc(subscription.Usage.Windows, func(window subscriptionUsageWindow) bool {
		return window.ModelFamily == "fable" && window.Utilization >= 1
	})
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

// useReset spends one banked reset after the user confirms, then shows
// what the provider answered. It reports whether it asked the provider.
func (page accountsPage) useReset(ctx context.Context, subscription subscriptionCredential, reset subscriptionReset, stdin io.Reader, stderr io.Writer) (bool, error) {
	name := subscriptionName(subscription)
	expiry := strings.TrimPrefix(resetExpiry(reset), " · ")
	if !reset.Usable {
		_, err := runAgentChoiceTUI(stdin, stderr, reset.Label+" can't be used yet", []string{"  " + ansiGray + cmp.Or(expiry, "No expiry") + ansiReset, ""}, []agentChoiceOption{{label: "Back"}})
		return false, err
	}
	details := []string{"  " + ansiGray + "Clears " + name + "'s usage limits now." + ansiReset}
	if expiry != "" {
		details = append(details, "  "+ansiGray+"This reset "+strings.ToLower(expiry[:1])+expiry[1:]+"."+ansiReset)
	}
	confirm, err := runAgentChoiceTUI(stdin, stderr, "Use "+reset.Label+"?", append(details, ""), []agentChoiceOption{{label: "Keep it"}, {label: "Use it"}})
	if err != nil || confirm == 0 {
		return false, err
	}
	result, err := useSubscriptionReset(ctx, page.client, subscription.Name, reset.ID)
	if err != nil {
		return true, err
	}
	_, err = runAgentChoiceTUI(stdin, stderr, resetResultText(result), nil, []agentChoiceOption{{label: "Back"}})
	if errors.Is(err, errAgentChoiceCanceled) {
		err = nil
	}
	return true, err
}

func resetExpiry(reset subscriptionReset) string {
	expires, err := time.Parse(time.RFC3339Nano, reset.ExpiresAt)
	if err != nil {
		return ""
	}
	return " · Expires " + expires.Local().Format("Jan 2")
}

// resetResultText says what a reset did, in the provider's own terms.
func resetResultText(result string) string {
	switch result {
	case "reset":
		return "Usage limits reset"
	case "nothing_to_reset", "not_limited":
		return "Nothing to reset: the plan isn't at a limit, so the reset was kept"
	case "no_credit", "already_used", "unavailable":
		return "That reset is no longer available"
	case "already_redeemed":
		return "That reset was already used"
	case "cooldown":
		return "Claude allows another reset only later; the reset was kept"
	case "ineligible":
		return "This plan can't use that reset now"
	}
	return "Reset not confirmed: " + result
}

// manageAPIKey is one API key's page, which can remove it. It reports
// whether it did.
func manageAPIKey(stdin io.Reader, stderr io.Writer, name string, remove func() error) (bool, error) {
	choice, err := runAgentChoiceTUI(stdin, stderr, name, nil, []agentChoiceOption{{label: "Remove"}, {label: "Back"}})
	if err != nil || choice == 1 {
		return false, err
	}
	confirm, err := runAgentChoiceTUI(stdin, stderr, "Remove "+name+"?", nil, []agentChoiceOption{{label: "Keep it"}, {label: "Remove", done: name + " removed"}})
	if err != nil || confirm == 0 {
		return false, err
	}
	return true, remove()
}
