package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/api"
)

// agentExperiment is a router template an org published: `dari <agent>
// --router <name>`, for any coding agent, launches on a copy of it in the
// current org.
type agentExperiment struct {
	Flag        string `json:"flag"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// What the admin lets run after the user's subscriptions.
	AllowBYOK    bool `json:"allow_byok"`
	AllowManaged bool `json:"allow_managed"`
	// pay and makeDefault are a launch's --pay and --default: the picker's
	// answers, for launches without it.
	pay         map[string]string
	makeDefault bool
}

func listAgentExperiments(ctx context.Context, client *api.Client) ([]agentExperiment, error) {
	var listed struct {
		ExperimentalRouters []agentExperiment `json:"experimental_routers"`
	}
	if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/experimental-routers", nil, &listed); err != nil {
		return nil, api.HumanError(err)
	}
	return listed.ExperimentalRouters, nil
}

// agentRouterChoice is a launch's `--router <name>`: a template's name, a
// router spec file, or a router ID, with the `--pay <model>=<way>` and
// `--default` answers for setup without a terminal.
type agentRouterChoice struct {
	name        string
	pay         map[string]string
	makeDefault bool
}

func (choice agentRouterChoice) file() bool {
	return choice.name != "" && looksLikeRouterManifestPath(choice.name)
}

func (choice agentRouterChoice) routerID() bool {
	return strings.HasPrefix(choice.name, "rtr_")
}

// takeAgentRouterChoice takes `--router <name>`, `--pay` and `--default` out
// of the agent's arguments.
func takeAgentRouterChoice(launch *agentLaunch) (agentRouterChoice, error) {
	choice := agentRouterChoice{pay: map[string]string{}}
	if _, ok := agentSetups[launch.name]; !ok {
		return choice, nil
	}
	end := slices.Index(launch.args, "--")
	if end < 0 {
		end = len(launch.args)
	}
	found := false
	var kept []string
	for i := 0; i < end; i++ {
		arg := launch.args[i]
		flagName, value, inline := strings.Cut(arg, "=")
		if flagName != "--router" && flagName != "--pay" {
			if arg == "--default" {
				choice.makeDefault = true
			} else {
				kept = append(kept, arg)
			}
			continue
		}
		if !inline {
			if i+1 >= end {
				return choice, fmt.Errorf("%s needs a value; list templates with `dari router experiments`", flagName)
			}
			i++
			value = launch.args[i]
		}
		if flagName != "--pay" {
			choice.name, found = value, true
			continue
		}
		model, way, ok := strings.Cut(value, "=")
		if !ok || model == "" {
			return choice, fmt.Errorf("--pay %s: write --pay <model>=<subscription|key|credits>", value)
		}
		choice.pay[model] = way
	}
	if !found && (len(choice.pay) > 0 || choice.makeDefault) {
		return choice, errors.New("--pay and --default go with --router <name>")
	}
	if found {
		launch.args = append(kept, launch.args[end:]...)
	}
	return choice, nil
}

// takeAgentExperiment takes the launch's router choice and, when it names a
// template, returns that template with the choice's answers.
func takeAgentExperiment(ctx context.Context, client *api.Client, launch *agentLaunch, stderr io.Writer) (*agentExperiment, error) {
	choice, err := takeAgentRouterChoice(launch)
	if err != nil || choice.name == "" {
		return nil, err
	}
	return lookupAgentExperiment(ctx, client, choice)
}

func lookupAgentExperiment(ctx context.Context, client *api.Client, choice agentRouterChoice) (*agentExperiment, error) {
	experiments, err := listAgentExperiments(ctx, client)
	if err != nil {
		return nil, fmt.Errorf("look up template %q: %w", choice.name, err)
	}
	for _, experiment := range experiments {
		if experiment.Flag == choice.name {
			experiment.pay, experiment.makeDefault = choice.pay, choice.makeDefault
			return &experiment, nil
		}
	}
	return nil, fmt.Errorf("no template %q; list them with `dari router experiments`", choice.name)
}

// experimentClientKeyPrefix marks the copy of a template an organization
// launches; the template's name follows it.
const experimentClientKeyPrefix = "dari-experiment:"

// experimentRouter is the organization's copy of a template, if one exists.
func experimentRouter(ctx context.Context, client *api.Client, flag string) (agentRouter, bool, error) {
	routers, err := listAgentRouters(ctx, client)
	if err != nil {
		return agentRouter{}, false, err
	}
	router, ok := findAgentRouter(routers, func(router agentRouter) bool {
		return router.ClientKey == experimentClientKeyPrefix+flag
	})
	return router, ok, nil
}

// routerPayment is the source a router pays for a model with, as its
// settings say it does.
func routerPayment(router agentRouter, modelID, modelProvider string) agentModelSource {
	if slices.Contains(router.SubscriptionProviders, modelProvider) && slices.Contains(router.SubscriptionModels, modelID) {
		return agentModelSource{kind: "subscription", provider: modelProvider}
	}
	if served := router.ModelProviders[modelID]; served != "" && served != modelProvider {
		return agentModelSource{kind: "key", provider: served}
	}
	if router.ProviderKeySources[modelProvider] == "user" {
		return agentModelSource{kind: "key", provider: modelProvider}
	}
	return agentModelSource{kind: "managed", provider: modelProvider}
}

// saveExperimentPayments pays each model of the copy the way its choice says.
func saveExperimentPayments(
	ctx context.Context,
	client *api.Client,
	router agentRouter,
	models []agentModel,
	choices []agentModelChoice,
	keyContext agentKeyContext,
) (agentRouter, error) {
	keys := keyContext.keys(choices)
	body := agentRouterUpdateBody(router, models, choices)
	keys.apply(body.ModelProviders, body.ProviderKeySources)
	for _, choice := range choices {
		// A provider with a saved key keeps it; the rest move to Dari credits.
		if _, ok := keys.credentialIDs[choice.Source.provider]; !ok && choice.Source.kind == "managed" &&
			!subscriptionOnlyProviders[choice.Source.provider] && slices.Contains(slices.Collect(maps.Values(body.ModelProviders)), choice.Source.provider) {
			body.ProviderKeySources[choice.Source.provider] = "managed"
		}
	}
	body.ProviderCredentialIDs = keys.credentialIDs
	body.SubscriptionAPIFallbackModels = keys.fallbackModels(router.SubscriptionAPIFallbackModels, body.EnabledModels)
	body.SubscriptionModels = subscriptionModelsFor(router, choices, keyContext.subscriptions)
	return putAgentRouter(ctx, client, router.ID, body)
}

// templateSubscriptions are the plans that can pay for a template's models
// in agent: the agent's own, and OpenCode Go, which serves any client.
func templateSubscriptions(setup agentSetup) []agentSubscriptionProvider {
	plans := slices.Clone(setup.subscriptions)
	if !slices.Contains(plans, opencodeGoSubscription) {
		plans = append(plans, opencodeGoSubscription)
	}
	return plans
}

// templateSetupSteps are the ways a model's picker row can set up a way to
// pay: connecting a subscription the template can use, or adding a key.
func templateSetupSteps(setup agentSetup, router agentRouter, keyContext agentKeyContext, provider string) []agentModelSource {
	var steps []agentModelSource
	for _, plan := range templateSubscriptions(setup) {
		if _, connected := keyContext.subscriptions[plan.routerProvider]; !connected &&
			plan.routerProvider == provider && slices.Contains(router.SubscriptionProviders, provider) {
			steps = append(steps, agentModelSource{kind: "connect", provider: provider, modelProvider: provider, label: "Connect " + plan.name})
		}
	}
	if _, hasKey := keyContext.saved[provider]; !hasKey && !keyContext.blocked["key"] && !subscriptionOnlyProviders[provider] {
		steps = append(steps, agentModelSource{kind: "add-key", provider: provider, modelProvider: provider, label: "Add " + keyContext.label(provider) + " Key"})
	}
	return steps
}

// templateModel is a template's model as the catalog names it.
func templateModel(models []agentModel, id string) agentModel {
	if i := slices.IndexFunc(models, func(model agentModel) bool { return model.ID == id }); i >= 0 {
		return models[i]
	}
	return agentModel{ID: id, DisplayName: id}
}

// chooseTemplatePayments shows every model of the template on one page, each
// with its ways to pay: a connected subscription, a saved key, Dari credits,
// or connecting a subscription or adding a key, which run and then bring the
// page back.
func chooseTemplatePayments(
	ctx context.Context,
	client *api.Client,
	stdin io.Reader,
	stderr io.Writer,
	setup agentSetup,
	experiment agentExperiment,
	router agentRouter,
	models []agentModel,
	modelProviders map[string]string,
	preferred map[string]agentModelSource,
	keyContext agentKeyContext,
	warning string,
) ([]agentModelChoice, agentKeyContext, error) {
	// What each model is on; setting something up moves it there, without
	// touching preferred, which quitting puts back.
	current := maps.Clone(preferred)
	cursor := 0
	var note []string
	if experiment.Description != "" {
		note = []string{experiment.Description}
	}
	for {
		var templateModels []agentModel
		sources := map[string][]agentModelSource{}
		for _, id := range router.EnabledModels {
			model, provider := templateModel(models, id), modelProviders[id]
			ways := append(keyContext.sources(model, provider), templateSetupSteps(setup, router, keyContext, provider)...)
			if len(ways) == 0 {
				return nil, keyContext, fmt.Errorf("nothing can pay for %s: the template allows neither your keys nor Dari credits for it", model.DisplayName)
			}
			sources[id] = ways
			templateModels = append(templateModels, model)
		}
		p := newAgentPickerState(templateModels, router.EnabledModels, router.ModelThinkingLevels, nil, sources)
		// Keep the template's order rather than grouping by provider.
		slices.SortStableFunc(p.rows, func(a, b agentPickerRow) int {
			return slices.Index(router.EnabledModels, a.model.ID) - slices.Index(router.EnabledModels, b.model.ID)
		})
		p.paying, p.fixed, p.cursor, p.warning = true, true, cursor, warning
		warning = ""
		for i := range p.rows {
			row := &p.rows[i]
			if role := router.roleOf(row.model.ID); role != "" {
				row.note = "Runs " + role
			}
			want := current[row.model.ID]
			if j := slices.IndexFunc(row.sources, func(source agentModelSource) bool {
				return source.kind == want.kind && source.provider == want.provider
			}); j >= 0 {
				row.source = j
			}
		}
		choices, err := runAgentPickerState(stdin, stderr, "How Should "+experiment.Name+"'s Models Be Paid For?", note, false, p)
		if err != nil {
			return nil, keyContext, err
		}
		for _, row := range p.rows {
			current[row.model.ID] = row.sources[row.source]
		}
		if p.action < 0 {
			for i := range choices {
				choices[i].Levels = router.ModelThinkingLevels[choices[i].ID]
			}
			return choices, keyContext, nil
		}
		cursor = p.cursor
		row := p.rows[p.action]
		step := row.sources[row.source]
		switch step.kind {
		case "connect":
			plan := templateSubscriptions(setup)[slices.IndexFunc(templateSubscriptions(setup), func(plan agentSubscriptionProvider) bool {
				return plan.routerProvider == step.provider
			})]
			// A failed or abandoned sign-in comes back here, saying why, so it
			// can be tried again and quitting still puts payments back.
			err := connectAgentPersonalSubscription(ctx, plan, client, stdin, stderr, "")
			if errors.Is(err, errAgentQuit) {
				return nil, keyContext, err
			}
			if err != nil && !errors.Is(err, errAgentChoiceCanceled) {
				warning = err.Error()
			}
			if err == nil {
				keyContext.subscriptions[plan.routerProvider] = plan.name
				current[row.model.ID] = agentModelSource{kind: "subscription", provider: step.provider}
			}
		case "add-key":
			saved, err := saveAgentAPIKey(ctx, client, stdin, stderr, step.provider, keyContext.label(step.provider))
			if errors.Is(err, errAgentQuit) {
				return nil, keyContext, err
			}
			if err != nil && !errors.Is(err, errAgentChoiceCanceled) {
				warning = err.Error()
				continue
			}
			if !saved {
				continue
			}
			// The key is saved; without the reload the page can't offer it.
			reloaded, err := loadAgentKeyContext(ctx, client, nil)
			if err != nil {
				return nil, keyContext, err
			}
			keyContext.saved = reloaded.saved
			if _, ok := keyContext.saved[step.provider]; ok {
				current[row.model.ID] = agentModelSource{kind: "key", provider: step.provider}
			}
		}
	}
}

// templatePayWays name, for --pay, the source kinds a launch can choose.
var templatePayWays = map[string]string{"subscription": "subscription", "key": "key", "credits": "managed"}

// withTemplatePay applies `--pay <model>=<subscription|key|credits>` to the
// choices, so a launch without a terminal chooses what the picker would.
func withTemplatePay(
	pay map[string]string,
	choices []agentModelChoice,
	models []agentModel,
	modelProviders map[string]string,
	keyContext agentKeyContext,
	setup agentSetup,
	router agentRouter,
) ([]agentModelChoice, error) {
	for name, way := range pay {
		i := slices.IndexFunc(choices, func(choice agentModelChoice) bool {
			_, short, _ := strings.Cut(choice.ID, "/")
			return name == choice.ID || name == short
		})
		if i < 0 {
			return nil, fmt.Errorf("--pay %s: the template has no such model; its models are %s", name, strings.Join(router.EnabledModels, ", "))
		}
		kind, ok := templatePayWays[way]
		if !ok {
			return nil, fmt.Errorf("--pay %s=%s: pay with subscription, key, or credits", name, way)
		}
		id := choices[i].ID
		provider := modelProviders[id]
		sources := keyContext.sources(templateModel(models, id), provider)
		j := slices.IndexFunc(sources, func(source agentModelSource) bool { return source.kind == kind })
		if j < 0 {
			return nil, fmt.Errorf("--pay %s=%s: %s", name, way, templatePayHelp(id, provider, sources, setup, router, keyContext))
		}
		choices[i].Source = sources[j]
	}
	return choices, nil
}

// templatePayHelp says how a model can be paid for now, and the commands
// that add another way.
func templatePayHelp(id, provider string, sources []agentModelSource, setup agentSetup, router agentRouter, keyContext agentKeyContext) string {
	ways := []string{}
	for _, source := range sources {
		for way, kind := range templatePayWays {
			if kind == source.kind && !slices.Contains(ways, way) {
				ways = append(ways, way)
			}
		}
	}
	slices.Sort(ways)
	help := id + " can't be paid for that way"
	if len(ways) > 0 {
		help += "; it can use " + strings.Join(ways, " or ")
	}
	for _, step := range templateSetupSteps(setup, router, keyContext, provider) {
		switch step.kind {
		case "connect":
			for name, plan := range subscriptionProviders {
				if plan.routerProvider == provider {
					help += fmt.Sprintf("; `dari accounts subscription connect %s` adds subscription", name)
					break
				}
			}
		case "add-key":
			help += fmt.Sprintf("; `dari accounts provider add %s <label> <api_key>` adds key", provider)
		}
	}
	return help
}

// applyAgentExperiment sets up the template's router in the current org,
// brought up to date with what the publisher sets now. In a terminal, the
// models picker shows how each model is paid for, starting from the copy's
// current choices, and is skipped once the agent runs on the copy. Then the
// agent is offered the copy as its default.
func applyAgentExperiment(
	ctx context.Context,
	client *api.Client,
	agent string,
	experiment agentExperiment,
	stdin io.Reader,
	stderr io.Writer,
) (string, error) {
	setup := agentSetups[agent]
	terminal := agentInputIsTerminal(stdin)
	// The copy as it stands before the sync, so its payment choices carry over.
	before, copied, err := experimentRouter(ctx, client, experiment.Flag)
	if err != nil {
		return "", err
	}
	var router agentRouter
	path := "/v1/organizations/current/experimental-routers/" + url.PathEscape(experiment.Flag) + "/apply"
	if err := postRouterSetup(ctx, client, agent, path, nil, &router, stdin, stderr); err != nil {
		return "", err
	}
	assigned := slices.Contains(router.CodingAgents, setup.codingAgent)

	models, err := listAgentModels(ctx, client)
	if err != nil {
		return "", err
	}
	// A template may use models Dari credits can't pay for; name them from
	// the catalog too.
	catalog, err := fetchAgentModelCatalog(ctx, client)
	if err != nil {
		return "", err
	}
	for _, group := range catalog.Groups {
		for _, model := range group.Models {
			if slices.Contains(router.EnabledModels, model.ID) && !slices.ContainsFunc(models, func(listed agentModel) bool { return listed.ID == model.ID }) {
				models = append(models, model)
			}
		}
	}
	models = includeCurrentAgentModels(models, router)
	connected, err := connectedAgentSubscriptions(ctx, client, templateSubscriptions(setup))
	if err != nil {
		return "", err
	}
	subscribed := slices.DeleteFunc(connected, func(subscription agentSubscriptionProvider) bool {
		return !slices.Contains(router.SubscriptionProviders, subscription.routerProvider)
	})
	keyContext, err := loadAgentKeyContext(ctx, client, subscribed)
	if err != nil {
		return "", err
	}
	keyContext.blocked = map[string]bool{"key": !experiment.AllowBYOK, "managed": !experiment.AllowManaged}
	// Each model is paid for through the provider the template serves it
	// with, which need not be the catalog's.
	modelProviders := agentProvidersFor(models, modelIDs(models))
	for id, provider := range router.ModelProviders {
		modelProviders[id] = provider
	}
	preferred := map[string]agentModelSource{}
	if copied {
		for _, id := range before.EnabledModels {
			preferred[id] = routerPayment(before, id, modelProviders[id])
		}
	}

	// What the copy pays with when nothing is asked: its earlier choices,
	// then the launch's --pay answers.
	settled := func() []agentModelChoice {
		var choices []agentModelChoice
		for _, id := range router.EnabledModels {
			choices = append(choices, agentModelChoice{ID: id, Levels: router.ModelThinkingLevels[id], Source: preferred[id]})
		}
		return keyContext.withSources(models, choices, modelProviders)
	}
	answered, payErr := withTemplatePay(experiment.pay, settled(), models, modelProviders, keyContext, setup, router)
	unpaid := slices.ContainsFunc(answered, func(choice agentModelChoice) bool { return choice.Source.kind == "" })
	// The template fixes its models, and may pin some to the main agent or
	// subagents, so only how each is paid for is asked: on a first launch
	// with no answers given, and whenever something still can't be paid
	// for, so a launch in a terminal never just fails.
	ask := terminal && !assigned && len(experiment.pay) == 0 && !experiment.makeDefault
	choose := ask || (terminal && (unpaid || payErr != nil))
	if payErr != nil && !choose {
		return "", payErr
	}
	start, warning := preferred, ""
	if payErr != nil {
		warning = payErr.Error()
	} else if choose && !ask {
		start = map[string]agentModelSource{}
		for _, choice := range answered {
			start[choice.ID] = choice.Source
		}
	}
	for {
		choices, quit := answered, false
		if choose {
			choices, keyContext, err = chooseTemplatePayments(ctx, client, stdin, stderr, setup, experiment, router, models, modelProviders, start, keyContext, warning)
			quit = errors.Is(err, errAgentChoiceCanceled) || errors.Is(err, errAgentQuit)
			if err != nil && !quit {
				return "", err
			}
			// A new copy keeps what apply set up, as a launch without a
			// terminal does; nothing the user chose is lost.
			if quit && !copied {
				return "", errAgentQuit
			}
			if quit {
				// Quitting puts back how the copy paid before the sync.
				choices = settled()
			} else {
				choices = keyContext.withSources(models, choices, modelProviders)
			}
		}
		if unpaid := slices.IndexFunc(choices, func(choice agentModelChoice) bool { return choice.Source.kind == "" }); unpaid >= 0 {
			if quit {
				return "", errAgentQuit
			}
			id := choices[unpaid].ID
			return "", fmt.Errorf("%s can't be paid for in %s: %s", id, experiment.Name,
				templatePayHelp(id, modelProviders[id], nil, setup, router, keyContext))
		}
		if !quit {
			agentStep(stderr, "Paying with "+agentSourceSummary(models, choices))
		}
		saved, saveErr := saveExperimentPayments(ctx, client, router, models, choices, keyContext)
		if saveErr != nil && choose && !quit {
			// Back to the page with what went wrong, to choose again.
			dropAgentStep("Paying with ")
			start, warning = map[string]agentModelSource{}, saveErr.Error()
			for _, choice := range choices {
				start[choice.ID] = choice.Source
			}
			continue
		}
		if saveErr != nil {
			return "", saveErr
		}
		if quit {
			return "", errAgentQuit
		}
		router = saved
		break
	}
	if experiment.makeDefault && !assigned {
		if err := assignAgentRouter(ctx, client, router.ID, setup.codingAgent); err != nil {
			return "", err
		}
		agentStep(stderr, experiment.Name+" is now your default for "+setup.label)
		return router.ID, nil
	}
	if !ask {
		agentStep(stderr, "Using template "+experiment.Name)
		return router.ID, nil
	}
	var details []string
	if experiment.Description != "" {
		details = []string{experiment.Description}
	}
	choice, err := runAgentChoiceTUI(stdin, stderr, fmt.Sprintf("Make %s Your Default Setup for %s?", experiment.Name, setup.label), details, []agentChoiceOption{
		{label: "Just This Launch", done: "Using template " + experiment.Name + " for this launch"},
		{label: "Make It My Default", description: fmt.Sprintf("Plain `dari %s` uses it too.", agent), done: experiment.Name + " is now your default for " + setup.label},
	})
	if err != nil {
		return "", err
	}
	if choice == 1 {
		if err := assignAgentRouter(ctx, client, router.ID, setup.codingAgent); err != nil {
			return "", err
		}
	}
	return router.ID, nil
}

func newRouterExperimentsCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "experiments",
		Short: "List router templates; launch one with `dari <agent> --router <name>`",
		Long: "List router templates; launch one with `dari <agent> --router <name>`. In a terminal the launch " +
			"asks how each model is paid for. Without one, or to skip the questions, add " +
			"`--pay <model>=<subscription|key|credits>` (repeatable; the model's ID or the part after its /) " +
			"and `--default` to make the template the agent's default.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/experimental-routers", nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

func newRouterPublishCmd(gf *globalFlags) *cobra.Command {
	var flag, name, description string
	var byok, managed bool
	cmd := &cobra.Command{
		Use:   "publish <router_id_or_endpoint>",
		Short: "Publish a router as a template anyone can launch with `dari <agent> --router <name>`",
		Long: "Publish one of your routers as a template anyone can launch with `dari <agent> --router <name>`. " +
			"Any coding agent can launch it. The name defaults to the router's, such as " +
			"deepseek-subagent. Each launch copies the router's current " +
			"configuration into the user's org; they pay with their subscriptions, then their own " +
			"keys, then Dari credits, and --byok=false or --managed=false takes those away. " +
			"Publishing again replaces what the template launches.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			routerID, err := normalizeRouterID(args[0])
			if err != nil {
				return err
			}
			body := map[string]any{
				"source_router_id": routerID,
				"allow_byok":       byok,
				"allow_managed":    managed,
			}
			if flag != "" {
				body["flag"] = strings.TrimPrefix(flag, "--")
			}
			if name != "" {
				body["name"] = name
			}
			if description != "" {
				body["description"] = description
			}
			var published agentExperiment
			if err := orgKeyRequest(cmd, gf, http.MethodPost, "/v1/organizations/current/experimental-routers", body, &published); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Published. Anyone can run: dari <agent> --router %s\n", published.Flag)
			return nil
		},
	}
	cmd.Flags().StringVar(&flag, "template", "", "Template name, such as deepseek-subagent (default: from the router's name)")
	cmd.Flags().StringVar(&name, "name", "", "Name users see (default: the router's name)")
	cmd.Flags().StringVar(&description, "description", "", "One line on what the router does")
	cmd.Flags().BoolVar(&byok, "byok", true, "Let users pay with their own provider keys after subscriptions")
	cmd.Flags().BoolVar(&managed, "managed", true, "Let users pay with Dari credits after their own keys")
	return cmd
}

func newRouterUnpublishCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "unpublish <template>",
		Short: "Stop publishing one of your templates; routers set up from it keep working",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			flag := strings.TrimPrefix(args[0], "--")
			if err := orgKeyRequest(cmd, gf, http.MethodDelete, "/v1/organizations/current/experimental-routers/"+url.PathEscape(flag), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(cmd.ErrOrStderr(), "Unpublished template %s\n", flag)
			return nil
		},
	}
}
