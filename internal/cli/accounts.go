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
				"`auto-routing` and `key` set the local gateway's Dari API key and provider API keys.",
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
			newAccountsLocalKeyCmd(),
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

// newAccountsLocalKeyCmd lists, saves, and removes the local gateway's
// provider API keys, as the Accounts page does.
func newAccountsLocalKeyCmd() *cobra.Command {
	names := []string{}
	for _, key := range localProviderKeys {
		names = append(names, strings.ToLower(strings.ReplaceAll(key.name, " ", "-")))
	}
	return &cobra.Command{
		Use:   "key [PROVIDER <api-key|off>]",
		Short: "Local gateway only: list provider API keys, or save or remove one",
		Long: "With no arguments, lists the providers and whether each has a key saved (never the key itself).\n" +
			"With a provider and a key, saves it; with `off`, removes it. Providers: " + strings.Join(names, ", ") + ".\n" +
			"Hosted Dari keeps provider keys as organization credentials: use `dari accounts provider`.",
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) != 0 && len(args) != 2 {
				return errors.New("expected no arguments, or a provider and an API key (or off)")
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 2 && strings.TrimSpace(args[1]) == "" {
				return errors.New("the API key is empty; pass the key, or off to remove the saved one")
			}
			gw, err := localGateway()
			if err != nil {
				return err
			}
			if len(args) == 2 {
				want := strings.ToLower(strings.TrimSpace(args[0]))
				index := slices.IndexFunc(localProviderKeys, func(key struct{ name, article, env string }) bool {
					return want == strings.ToLower(strings.ReplaceAll(key.name, " ", "-")) || want == strings.ToLower(key.name) || want == strings.ToLower(key.env)
				})
				if index < 0 {
					return fmt.Errorf("unknown provider %q: expected one of %s", args[0], strings.Join(names, ", "))
				}
				env, value := localProviderKeys[index].env, strings.TrimSpace(args[1])
				if strings.EqualFold(value, "off") {
					value = ""
				}
				if err := setLocalProviderKey(cmd.Context(), gw, cmd.ErrOrStderr(), env, value); err != nil {
					return err
				}
			}
			keys := []map[string]any{}
			for i, key := range localProviderKeys {
				keys = append(keys, map[string]any{"provider": names[i], "name": key.name, "saved": gw.settings.ProviderKeys[key.env] != ""})
			}
			return printJSON(map[string]any{"keys": keys})
		},
	}
}

// runAccounts opens the Accounts page wherever coding agents route: the
// hosted Dari API, or the local or self-hosted gateway.
func runAccounts(ctx context.Context, gf *globalFlags, stdin io.Reader, stderr io.Writer) error {
	agentSubtitle = "Subscriptions and keys"
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
	// computer manages the plans on this computer's gateway beside hosted
	// ones; nil when it has none.
	computer *api.Client
}

// clientFor is the API that manages a subscription: this computer's gateway
// for a plan on it, and otherwise the page's.
func (page accountsPage) clientFor(subscription subscriptionCredential) *api.Client {
	if subscription.place != "" && subscription.place != placeDari {
		return page.computer
	}
	return page.client
}

// subscriptionKey tells apart a hosted plan and one on this computer that
// share a credential name.
func subscriptionKey(subscription subscriptionCredential) string {
	return string(subscription.place) + ":" + subscription.Name
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
	var computerPlans []subscriptionCredential
	stale, routing := true, true
	resets := map[string]*resetsFetch{}
	showAgentLoading(stderr, "Loading accounts")
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
				if computerPlans, page.computer, err = computerSubscriptions(ctx, raw, stderr); err != nil {
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
		subscriptions := slices.DeleteFunc(append(personalSubscriptions(listed.Credentials), computerPlans...), func(c subscriptionCredential) bool {
			return !slices.ContainsFunc(page.providers, func(p agentSubscriptionProvider) bool { return p.id == c.OAuthProvider })
		})
		// Each subscription's banked resets load while the list shows, so its
		// page opens without waiting.
		for _, subscription := range subscriptions {
			if hasBankedResets(subscription) && resets[subscriptionKey(subscription)] == nil {
				resets[subscriptionKey(subscription)] = fetchSubscriptionResets(ctx, page.clientFor(subscription), subscription.Name)
			}
		}
		if i := slices.IndexFunc(subscriptions, func(c subscriptionCredential) bool { return subscriptionKey(c) == reopen }); i >= 0 {
			outcome, err := page.manageSubscription(ctx, subscriptions[i], subscriptions, resets[reopen], stdin, stderr)
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
				finish = agentChoiceOption{label: "Use Dari Managed Billing", done: "Using Dari managed billing"}
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
			add(option, func() (bool, error) {
				outcome, err := page.manageSubscription(ctx, subscription, subscriptions, resets[subscriptionKey(subscription)], stdin, stderr)
				changed = outcome != subscriptionPageBack
				if outcome == subscriptionPageActed {
					reopen = subscriptionKey(subscription)
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
		// Done closes the Settings section, after what can still be added.
		add(agentChoiceOption{label: "Add a Subscription", heading: "Settings"}, func() (bool, error) {
			provider, ok, err := page.addSubscription(ctx, subscriptions, stdin, stderr)
			changed = ok
			if ok && !slices.Contains(result.added, provider) {
				result.added = append(result.added, provider)
			}
			return false, err
		})
		switch {
		case page.hosted:
			add(agentChoiceOption{label: "Add an API Key"}, func() (bool, error) {
				saved, err := connectAgentAPIKey(ctx, page.client, stdin, stderr, keys)
				changed = saved
				if saved {
					result.keysAdded++
				}
				return false, err
			})
			if !routing {
				add(agentChoiceOption{label: "Get Auto-Routing"}, func() (bool, error) {
					_, err := getAutorouting(ctx, page.client, stdin, stderr)
					return false, err
				})
			}
		case page.local():
			add(agentChoiceOption{label: "Add an API Key"}, func() (bool, error) {
				return false, page.addLocalKey(ctx, stdin, stderr)
			})
			label := "Add a Dari API key for auto-routing"
			if page.gw.settings.AutoRoutingKey != "" {
				label = "Replace the auto-routing Dari API key"
			}
			add(agentChoiceOption{label: label}, func() (bool, error) {
				_, err := runAgentSecretInputTUI(stdin, stderr, "Dari API Key", nil, func(value string) error {
					page.gw.settings.AutoRoutingKey = value
					return saveLocalGateway(ctx, page.gw, stderr)
				})
				return false, err
			})
		}
		finish.gap = true
		add(finish, leave)

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
	nameWidth := 0
	for _, provider := range page.providers {
		nameWidth = max(nameWidth, len([]rune(provider.name)))
	}
	for i, provider := range page.providers {
		option := agentChoiceOption{label: provider.name}
		if i == 0 {
			option.heading = "Connect an Account"
		}
		if slices.ContainsFunc(subscriptions, func(c subscriptionCredential) bool { return c.OAuthProvider == provider.id }) {
			option.label = padRight(provider.name, nameWidth) + "  " + ansiGray + "another account" + ansiReset
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
	// On hosted Dari a plan can live there or on this computer, as with
	// `dari accounts subscription connect`.
	place := placeDari
	if page.hosted {
		if place, err = chooseSubscriptionPlace(stdin, stderr, selected.provider, "", ""); err != nil {
			if errors.Is(err, errAgentChoiceCanceled) {
				err = nil
			}
			return agentSubscriptionProvider{}, false, err
		}
	}
	if place == placeDari {
		err = connectAgentPersonalSubscription(ctx, selected.provider, page.client, stdin, stderr, "")
	} else {
		err = connectOnComputer(ctx, selected.provider, place, stdin, stderr)
	}
	if err != nil {
		return agentSubscriptionProvider{}, false, err
	}
	return selected.provider, true, nil
}

// manageSubscription is one subscription's page: its usage in a box like the
// list's, its banked resets to use, and its settings. It shows itself again
// after anything that changed nothing, and otherwise reports how it was left.
func (page accountsPage) manageSubscription(ctx context.Context, subscription subscriptionCredential, all []subscriptionCredential, prefetched *resetsFetch, stdin io.Reader, stderr io.Writer) (subscriptionPageOutcome, error) {
	name := subscriptionName(subscription)
	provider := subscriptionProviderFor(subscription.OAuthProvider)
	path := "/v1/organizations/current/credentials/" + url.PathEscape(subscription.Name)
	client := page.clientFor(subscription)
	resettable := hasBankedResets(subscription)
	var resets []subscriptionReset
	var resetsErr error
	readAt := ""
	if resettable {
		if prefetched == nil {
			prefetched = fetchSubscriptionResets(ctx, client, subscription.Name)
		}
		resets, resetsErr = prefetched.wait()
		readAt = prefetched.readAt
	}
	// Every subscription's page lays out its box the same: the list's columns,
	// and the width of the widest subscription's box.
	columns := subscriptionColumnsFor(all)
	summary := func(subscription subscriptionCredential) []string {
		rows := []string{subscriptionLabel(subscription, true, columns)}
		// Without a number before the name, the meters start where it does.
		for _, detail := range subscriptionDetailLines(subscription, columns) {
			rows = append(rows, strings.TrimPrefix(detail, "  "))
		}
		return rows
	}
	boxWidth := 0
	for _, other := range all {
		for _, row := range summary(other) {
			boxWidth = max(boxWidth, ansiVisibleWidth(row))
		}
	}
	rows := summary(subscription)
	rows[0] += strings.Repeat(" ", max(0, boxWidth-ansiVisibleWidth(rows[0])))
	details := []string{}
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
				// A list the provider would not give again now says how old it is.
				if read, err := time.Parse(time.RFC3339Nano, readAt); err == nil {
					option.heading += ansiReset + ansiGray + " · as of " + usageResetTime(read)
				}
			}
			add(option, func() (bool, error) {
				return useResetPage(ctx, client, subscription, reset, stdin, stderr)
			})
		}
		if resettable {
			// The setting shows its state, and changing it asks first, so a
			// stray number key changes nothing.
			state, turn, keep := ansiGray+"Off"+ansiReset, "Turn on", "Keep off"
			if subscription.AutoRedeemResets {
				state, turn, keep = ansiGreen+"On"+ansiReset, "Turn off", "Keep on"
			}
			toggle := agentChoiceOption{label: "Use Automatically: " + state}
			if len(resets) == 0 {
				toggle.heading = "Banked Resets"
			}
			add(toggle, func() (bool, error) {
				explain := []string{
					"Spends one when every " + provider.name + " subscription is at its limit.",
					"  " + ansiGray + "Now: " + ansiReset + state,
				}
				confirm, err := runAgentChoiceTUI(stdin, stderr, "Use Banked Resets Automatically?", explain, []agentChoiceOption{{label: keep}, {label: turn}})
				if err != nil || confirm == 0 {
					return false, err
				}
				var updated map[string]any
				return true, api.HumanError(client.Do(ctx, http.MethodPut, path+"/auto-reset", map[string]bool{"enabled": !subscription.AutoRedeemResets}, &updated))
			})
		}
		settings := len(options)
		if provider.billingURL != "" {
			add(agentChoiceOption{label: "Manage Plan at " + provider.vendor}, func() (bool, error) {
				if openAgentBrowser(provider.billingURL) {
					agentStep(stderr, "Opened "+provider.vendor+"; sign in as "+name+" if another account is open")
				} else {
					agentPrintln(stderr, "Manage the plan, signed in as "+name+", at:\n  "+provider.billingURL)
				}
				return false, nil
			})
		}
		add(agentChoiceOption{label: "Rename"}, func() (bool, error) {
			return runAgentTextInputTUI(stdin, stderr, "Rename "+name, []string{"Empty shows the account email."}, name, func(label string) error {
				var updated map[string]any
				return api.HumanError(client.Do(ctx, http.MethodPut, path+"/label", map[string]string{"label": strings.TrimSpace(label)}, &updated))
			})
		})
		if subscriptionStatus(subscription) == "held" || len(activeModelHolds(subscription, time.Now())) > 0 {
			add(agentChoiceOption{label: "Mark Available"}, func() (bool, error) {
				var updated map[string]any
				return true, api.HumanError(client.Do(ctx, http.MethodPost, path+"/mark-available", nil, &updated))
			})
		}
		// Reconnect and Disconnect, the connection's own actions, sit together.
		add(agentChoiceOption{label: "Reconnect"}, func() (bool, error) {
			err := connectAgentPersonalSubscription(ctx, provider, client, stdin, stderr, subscription.Name)
			return err == nil, err
		})
		disconnected := false
		add(agentChoiceOption{label: "Disconnect"}, func() (bool, error) {
			details := []string{"Routing stops using it."}
			confirm, err := runAgentChoiceTUI(stdin, stderr, "Disconnect "+name+"?", details, []agentChoiceOption{{label: "Keep It"}, {label: "Disconnect", done: name + " disconnected"}})
			if err != nil || confirm == 0 {
				return false, err
			}
			disconnected = true
			return true, api.HumanError(client.Do(ctx, http.MethodDelete, path+"?scope=user", nil, nil))
		})
		options[settings].heading = "Settings"
		options = append(options, agentChoiceOption{label: "Back", gap: true})

		// The summary box's left edge lines up with the sections' ◆, its text
		// with their titles.
		choice, err := runAgentSummaryChoiceTUI(stdin, stderr, rows, details, options)
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
	readAt string
	err    error
}

func fetchSubscriptionResets(ctx context.Context, client *api.Client, name string) *resetsFetch {
	fetch := &resetsFetch{done: make(chan struct{})}
	go func() {
		defer close(fetch.done)
		fetch.resets, fetch.readAt, fetch.err = listSubscriptionResets(ctx, client, name)
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
	choice, err := runAgentChoiceTUI(stdin, stderr, "Add an API Key", nil, options)
	if err != nil || choice == len(localProviderKeys) {
		return err
	}
	key := localProviderKeys[choice]
	_, err = runAgentSecretInputTUI(stdin, stderr, key.name+" API key", nil, func(value string) error {
		return setLocalProviderKey(ctx, page.gw, stderr, key.env, value)
	})
	return err
}

// setLocalProviderKey stores a provider API key in the local gateway, or
// removes it when value is empty, and saves the gateway.
func setLocalProviderKey(ctx context.Context, gw *gatewayConfig, stderr io.Writer, env, value string) error {
	if value == "" {
		delete(gw.settings.ProviderKeys, env)
	} else {
		if gw.settings.ProviderKeys == nil {
			gw.settings.ProviderKeys = map[string]string{}
		}
		gw.settings.ProviderKeys[env] = value
	}
	return saveLocalGateway(ctx, gw, stderr)
}

// buyAgentSubscription opens the vendor's plan page, where the user signs up
// with another account and subscribes. It reports whether they subscribed and
// want to connect the new account now.
func buyAgentSubscription(stdin io.Reader, stderr io.Writer, provider agentSubscriptionProvider) (bool, error) {
	details := []string{"Needs its own " + provider.vendor + " account."}
	if openAgentBrowser(provider.buyURL) {
		details = append(details, "Opened in your browser. If it didn't open:")
	} else {
		details = append(details, "Subscribe at:")
	}
	details = append(details, agentURLLines(provider.buyURL, 0)...)
	choice, err := runAgentChoiceTUI(stdin, stderr, "Buy a "+provider.name+" Subscription", details, []agentChoiceOption{
		{label: "I've Subscribed, Connect It"},
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
func useResetPage(ctx context.Context, client *api.Client, subscription subscriptionCredential, reset subscriptionReset, stdin io.Reader, stderr io.Writer) (bool, error) {
	name := subscriptionName(subscription)
	expiry := strings.TrimPrefix(resetExpiry(reset), " · ")
	if !reset.Usable {
		_, err := runAgentChoiceTUI(stdin, stderr, reset.Label+" can't be used yet", []string{"  " + ansiGray + cmp.Or(expiry, "No expiry") + ansiReset, ""}, []agentChoiceOption{{label: "Back"}})
		return false, err
	}
	details := []string{"Clears " + name + "'s usage limits now."}
	if expiry != "" {
		details = append(details, "  "+ansiGray+"This reset "+strings.ToLower(expiry[:1])+expiry[1:]+"."+ansiReset)
	}
	confirm, err := runAgentChoiceTUI(stdin, stderr, "Use "+reset.Label+"?", append(details, ""), []agentChoiceOption{{label: "Keep It"}, {label: "Use It"}})
	if err != nil || confirm == 0 {
		return false, err
	}
	// Whatever happened, the answer shows here and the page reloads after it.
	result, err := useSubscriptionReset(ctx, client, subscription.Name, reset.ID)
	text := resetResultText(result)
	if err != nil {
		text = "Couldn't use that reset: " + err.Error()
	}
	_, err = runAgentChoiceTUI(stdin, stderr, text, nil, []agentChoiceOption{{label: "Back"}})
	if errors.Is(err, errAgentChoiceCanceled) {
		err = nil
	}
	return true, err
}

func resetExpiry(reset subscriptionReset) string {
	if reset.ExpiresAt == nil {
		return ""
	}
	expires, err := time.Parse(time.RFC3339Nano, *reset.ExpiresAt)
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
		return "That reset is no longer available; it was used or expired"
	case "not_usable":
		return "That reset can't be used yet"
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
	for {
		choice, err := runAgentChoiceTUI(stdin, stderr, name, nil, []agentChoiceOption{{label: "Remove"}, {label: "Back", gap: true}})
		if err != nil || choice == 1 {
			return false, err
		}
		details := []string{"Routers stop using it."}
		confirm, err := runAgentChoiceTUI(stdin, stderr, "Remove "+name+"?", details, []agentChoiceOption{{label: "Keep It"}, {label: "Remove", done: name + " removed"}})
		// Esc or Keep it comes back to the key's page.
		if errors.Is(err, errAgentChoiceCanceled) || (err == nil && confirm == 0) {
			continue
		}
		if err != nil {
			return false, err
		}
		return true, remove()
	}
}
