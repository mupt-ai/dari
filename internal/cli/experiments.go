package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/api"
)

// agentExperiment is a router template an org published: `dari <agent>
// --template <name>`, for any coding agent, launches on a copy of it in the
// current org.
type agentExperiment struct {
	Flag        string `json:"flag"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// What the admin lets run after the user's subscriptions.
	AllowBYOK    bool `json:"allow_byok"`
	AllowManaged bool `json:"allow_managed"`
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

// takeAgentExperiment takes `--template <name>` (or `--template=<name>`)
// out of the agent's arguments and returns the template it names for the
// launched agent. Launches without it skip the lookup.
func takeAgentExperiment(ctx context.Context, client *api.Client, launch *agentLaunch, stderr io.Writer) (*agentExperiment, error) {
	_, ok := agentSetups[launch.name]
	if !ok {
		return nil, nil
	}
	end := slices.Index(launch.args, "--")
	if end < 0 {
		end = len(launch.args)
	}
	name, start, stop := "", -1, -1
	for i, arg := range launch.args[:end] {
		if value, found := strings.CutPrefix(arg, "--template="); found {
			name, start, stop = value, i, i+1
			break
		}
		if arg == "--template" {
			if i+1 >= end {
				return nil, fmt.Errorf("--template needs a name; list them with `dari router experiments`")
			}
			name, start, stop = launch.args[i+1], i, i+2
			break
		}
	}
	if start < 0 {
		return nil, nil
	}
	experiments, err := listAgentExperiments(ctx, client)
	if err != nil {
		return nil, fmt.Errorf("look up template %q: %w", name, err)
	}
	for _, experiment := range experiments {
		if experiment.Flag == name {
			launch.args = slices.Delete(launch.args, start, stop)
			return &experiment, nil
		}
	}
	return nil, fmt.Errorf("no template %q; list them with `dari router experiments`", name)
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
		if _, ok := keys.credentialIDs[choice.Source.provider]; !ok && choice.Source.kind == "managed" {
			body.ProviderKeySources[choice.Source.provider] = "managed"
		}
	}
	body.ProviderCredentialIDs = keys.credentialIDs
	body.SubscriptionAPIFallbackModels = keys.fallbackModels(router.SubscriptionAPIFallbackModels, body.EnabledModels)
	body.SubscriptionModels = subscriptionModelsFor(router, choices, keyContext.subscriptions)
	return putAgentRouter(ctx, client, router.ID, body)
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
	if err := client.Do(ctx, http.MethodPost, path, nil, &router); err != nil {
		return "", api.HumanError(err)
	}
	assigned := slices.Contains(router.CodingAgents, setup.codingAgent)
	choose := terminal && !assigned

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
	connected, err := connectedAgentSubscriptions(ctx, client, setup.subscriptions)
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
	modelProviders := agentProvidersFor(models, modelIDs(models))
	preferred := map[string]agentModelSource{}
	if copied {
		for _, id := range before.EnabledModels {
			preferred[id] = routerPayment(before, id, modelProviders[id])
		}
	}

	// The template fixes its models, and may pin some to the main agent or
	// subagents, so only how each is paid for is chosen.
	var choices []agentModelChoice
	quit := false
	if choose {
		var fixed []agentModel
		sources := map[string][]agentModelSource{}
		for _, model := range models {
			if slices.Contains(router.EnabledModels, model.ID) {
				fixed = append(fixed, model)
				sources[model.ID] = keyContext.sourcesPreferring(model, modelProviders[model.ID], preferred[model.ID])
			}
		}
		choices, err = runAgentPaymentPicker(stdin, stderr, fixed, router.ModelThinkingLevels, sources)
		quit = errors.Is(err, errAgentQuit)
		if err != nil && !quit {
			return "", err
		}
		// A new copy keeps what apply set up, as a launch without a terminal
		// does; nothing the user chose is lost.
		if quit && !copied {
			return "", errAgentQuit
		}
	}
	if !choose || quit {
		choices = nil
		for _, id := range router.EnabledModels {
			choices = append(choices, agentModelChoice{
				ID:     id,
				Levels: router.ModelThinkingLevels[id],
				Source: preferred[id],
			})
		}
	}
	choices = keyContext.withSources(models, choices, modelProviders)
	for _, choice := range choices {
		if choice.Source.kind == "" {
			if quit {
				return "", errAgentQuit
			}
			return "", fmt.Errorf("%s can't be paid for in %s: connect its subscription, or leave it out of the template", choice.ID, experiment.Name)
		}
	}
	if !quit {
		agentStep(stderr, "Paying with "+agentSourceSummary(models, choices))
	}
	// Quitting puts back how the copy paid before the sync.
	router, err = saveExperimentPayments(ctx, client, router, models, choices, keyContext)
	if err != nil {
		return "", err
	}
	if quit {
		return "", errAgentQuit
	}
	if assigned || !terminal {
		agentStep(stderr, "Using template "+experiment.Name)
		return router.ID, nil
	}
	var details []string
	if experiment.Description != "" {
		details = []string{experiment.Description}
	}
	choice, err := runAgentChoiceTUI(stdin, stderr, fmt.Sprintf("Make %s your default setup for %s?", experiment.Name, setup.label), details, []agentChoiceOption{
		{label: "Just this launch", description: fmt.Sprintf("`dari %s` without --template keeps your current setup.", agent), done: "Using template " + experiment.Name + " for this launch"},
		{label: "Make it my default", description: fmt.Sprintf("`dari %s` uses it from now on; `dari router assign-agent` moves %s back.", agent, setup.label), done: experiment.Name + " is now your default for " + setup.label},
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
		Short: "List router templates; launch one with `dari <agent> --template <name>`",
		Args:  cobra.NoArgs,
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
		Short: "Publish a router as a template anyone can launch with `dari <agent> --template <name>`",
		Long: "Publish one of your routers as a template anyone can launch with `dari <agent> --template <name>`. " +
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
			fmt.Fprintf(cmd.OutOrStdout(), "Published. Anyone can run: dari <agent> --template %s\n", published.Flag)
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
