package cli

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/gateway"
	"github.com/mupt-ai/dari/internal/state"
)

// `dari setup <agent>` is where every setup choice lives, hosted or on a
// gateway: the router and its models, how each is paid for, whether it is
// the agent's default, and whether the agent run directly or its desktop app
// uses Dari too.
func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		root.AddCommand(newSetupCmd())
	})
}

func newSetupCmd() *cobra.Command {
	var cli, desktop, remove, makeDefault, refresh bool
	var router string
	var pay []string
	cmd := &cobra.Command{
		Use:   "setup <agent>",
		Short: "Choose an agent's router, models, and payment; --cli and --desktop set up the agent run directly",
		Long: "Choose the router a coding agent uses, its models, and how each is paid for, hosted or on a\n" +
			"local or self-hosted gateway. Agents are " + strings.Join(slices.Sorted(maps.Keys(agentLaunchers)), ", ") + ".\n\n" +
			"With no flags it opens the models picker on the agent's router. --router uses another:\n" +
			"  dari setup claude --router opus-5-5-deepseek-subagents   # a template (`dari router experiments`)\n" +
			"  dari setup claude --router ./router.yaml                  # a router spec file\n" +
			"  dari setup claude --router rtr_123                        # one of your routers\n" +
			"On a gateway, --router puts that router on the gateway.\n\n" +
			"For scripts and agents, --pay answers how each model is paid for and --default makes the\n" +
			"router the agent's default, so nothing is asked:\n" +
			"  dari setup claude --router deepseek --pay claude-opus-5-5=subscription --pay flash=credits --default\n\n" +
			"--cli makes the agent run directly (plain `claude`) use Dari; --desktop does the same for its\n" +
			"desktop app; --remove undoes both.\n\n" +
			"`dari setup codex --refresh` brings Codex's /model list up to the router's models now, on the\n" +
			"router it is set up with, without asking anything.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]
			if _, ok := agentLaunchers[name]; !ok {
				return fmt.Errorf("unknown agent %q; use one of %s", name, strings.Join(slices.Sorted(maps.Keys(agentLaunchers)), ", "))
			}
			if refresh {
				if name != "codex" {
					return fmt.Errorf("--refresh is for codex; run `dari setup %s` to update %s's models", name, name)
				}
				if cli || desktop || remove || makeDefault || router != "" || len(pay) > 0 {
					return errors.New("--refresh takes no other flags")
				}
				return runCodexRefresh(cmd.Context(), cmd.ErrOrStderr())
			}
			launch := agentLaunch{name: name, setupCLI: cli, setupDesktop: desktop, removeSetup: remove, reconfigure: router == ""}
			if router != "" {
				launch.args = append(launch.args, "--router", router)
			}
			for _, answer := range pay {
				launch.args = append(launch.args, "--pay", answer)
			}
			if makeDefault {
				launch.args = append(launch.args, "--default")
			}
			if setup, ok := agentSetups[name]; ok {
				agentSubtitle = "Setting up " + setup.label
			}
			stdin, stderr := cmd.InOrStdin(), cmd.ErrOrStderr()
			if launch.setup() || launch.removeSetup {
				if launch.removeSetup && len(launch.args) > 0 {
					return errors.New("--remove takes no other flags")
				}
				return runAgentSetup(cmd.Context(), launch, stdin, stderr)
			}
			_, _, _, err := resolveAgentRouting(cmd.Context(), &launch, stdin, stderr)
			if errors.Is(err, errAgentQuit) {
				return nil
			}
			return err
		},
	}
	cmd.Flags().BoolVar(&cli, "cli", false, "Also make the agent run directly use Dari")
	cmd.Flags().BoolVar(&desktop, "desktop", false, "Also make the agent's desktop app use Dari")
	cmd.Flags().BoolVar(&remove, "remove", false, "Remove Dari from the agent run directly and its desktop app")
	cmd.Flags().StringVar(&router, "router", "", "A template, router spec file, or router ID to use")
	cmd.Flags().StringArrayVar(&pay, "pay", nil, "How a model is paid for, as <model>=<subscription|key|credits> (repeatable)")
	cmd.Flags().BoolVar(&makeDefault, "default", false, "Make --router the agent's default")
	cmd.Flags().BoolVar(&refresh, "refresh", false, "Codex: bring the /model list up to the router's models now")
	return cmd
}

// useHostedRouter sets up a router spec file (applying it to the router with
// its name) or uses one of the organization's routers, by ID. --default makes
// it the agent's.
func useHostedRouter(ctx context.Context, client *api.Client, agent string, choice agentRouterChoice, stdin io.Reader, stderr io.Writer) (string, error) {
	if len(choice.pay) > 0 {
		return "", errors.New("--pay goes with a template; a router file or ID keeps the router's payment")
	}
	routerID := choice.name
	if choice.file() {
		spec, err := loadRouterSpec(choice.name)
		if err != nil {
			return "", err
		}
		var applied agentRouter
		if err := postRouterSetup(ctx, client, agent, "/v1/organizations/current/routers/apply", map[string]any{"spec_yaml": spec}, &applied, stdin, stderr); err != nil {
			return "", err
		}
		routerID = applied.ID
		agentStep(stderr, "Using "+applied.Name)
	}
	if choice.makeDefault {
		if err := assignAgentRouter(ctx, client, routerID, agentSetups[agent].codingAgent); err != nil {
			return "", err
		}
		agentStep(stderr, "It is now your default for "+agentSetups[agent].label)
	}
	return routerID, nil
}

// postRouterSetup posts a router setup. Where the API refuses it because
// nothing can pay for a model yet, a launch in a terminal offers to connect a
// subscription or add a key right there, then tries again.
func postRouterSetup(ctx context.Context, client *api.Client, agent, path string, body, out any, stdin io.Reader, stderr io.Writer) error {
	for {
		err := client.Do(ctx, http.MethodPost, path, body, out)
		if err == nil {
			return nil
		}
		// 424: not a bad spec, but one nothing can pay for yet. (402 is the
		// API's out-of-credits answer.)
		unpaid := api.AsHTTPError(err) != nil && api.AsHTTPError(err).Status == http.StatusFailedDependency
		if !unpaid || !agentInputIsTerminal(stdin) {
			return api.HumanError(err)
		}
		details := []string{"  " + ansiRed + api.HumanError(err).Error() + ansiReset, ""}
		picked, pickErr := runAgentChoiceTUI(stdin, stderr, "This Router Can't Run Yet", details, []agentChoiceOption{
			{label: "Connect a Subscription or Add an API Key"},
			{label: "Quit"},
		})
		if pickErr != nil || picked == 1 {
			return errAgentQuit
		}
		page := accountsPage{client: client, providers: templateSubscriptions(agentSetups[agent]), hosted: true}
		if _, pageErr := page.run(ctx, stdin, stderr); pageErr != nil && !errors.Is(pageErr, errAgentChoiceCanceled) {
			return pageErr
		}
	}
}

var gatewayRouterIDPattern = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

// gatewayAgentRouter is the gateway URL a launch routes through: the router
// --router names, which it puts on the gateway first, else the router
// `--default` made the agent's, else the gateway's default router.
func gatewayAgentRouter(ctx context.Context, gw *gatewayConfig, launch *agentLaunch, choice agentRouterChoice, stdin io.Reader, stderr io.Writer) (string, error) {
	if choice.name == "" {
		id := gw.settings.AgentRouters[launch.name]
		if id == "" {
			return gw.url, nil
		}
		if launch.reconfigure {
			// A spec router's models are its file's; the picker edits only
			// the gateway's default router.
			agentStep(stderr, fmt.Sprintf("%s uses %s, a router spec: change it with `dari router get %s > %s.yaml` and `dari router apply %s.yaml`, or go back with `dari setup %s --router default --default`",
				agentSetups[launch.name].label, id, id, id, id, launch.name))
		}
		return gw.url + "/" + url.PathEscape(id), nil
	}
	if len(choice.pay) > 0 {
		return "", errors.New("--pay is for hosted Dari; a gateway pays with its own subscriptions and keys")
	}
	// Checked before anything is saved on the gateway.
	if choice.makeDefault && !gw.local {
		return "", errors.New("--default works on a local gateway; point a self-hosted gateway's agents at <gateway>/<router>")
	}
	if err := gw.ensure(ctx, stderr); err != nil {
		return "", err
	}
	id := choice.name
	if id != "default" {
		spec, specID, err := gatewayRouterSpec(ctx, choice)
		if err != nil {
			return "", err
		}
		var saved struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		path := "/v1/routers/" + url.PathEscape(specID)
		if err := api.New(gw.url).WithBearer(gw.key).Do(ctx, http.MethodPut, path, map[string]any{"spec_yaml": spec}, &saved); err != nil {
			return "", fmt.Errorf("put %s on the gateway: %w", specID, gatewayRouterError(err))
		}
		id = specID
		agentStep(stderr, fmt.Sprintf("Using %s on the gateway", cmp.Or(saved.Name, id)))
	}
	if choice.makeDefault {
		if id == "default" {
			delete(gw.settings.AgentRouters, launch.name)
		} else {
			gw.settings.AgentRouters = setKey(gw.settings.AgentRouters, launch.name, id)
		}
		if err := gateway.Save(gw.settings); err != nil {
			return "", err
		}
		agentStep(stderr, fmt.Sprintf("%s is now your default for %s", id, agentSetups[launch.name].label))
	}
	if id == "default" {
		return gw.url, nil
	}
	return gw.url + "/" + url.PathEscape(id), nil
}

// gatewayRouterSpec is the spec a gateway runs for --router, and the router
// ID it runs under: a file's own, or a template or hosted router fetched from
// the signed-in organization.
func gatewayRouterSpec(ctx context.Context, choice agentRouterChoice) (string, string, error) {
	if choice.file() {
		spec, err := loadRouterSpec(choice.name)
		if err != nil {
			return "", "", err
		}
		return spec, gatewayRouterIDForFile(choice.name), nil
	}
	apiURL := api.DefaultAPIURL
	if saved, err := state.Load(); err == nil && saved.APIURL != "" {
		apiURL = saved.APIURL
	}
	if env := strings.TrimSpace(os.Getenv("DARI_API_URL")); env != "" {
		apiURL = env
	}
	apiURL = api.NormalizeURL(apiURL)
	// A template is public; only one of your own routers needs a sign-in.
	client := api.New(apiURL)
	path := "/v1/router-templates/" + url.PathEscape(choice.name) + "/spec?format=yaml"
	if choice.routerID() {
		signedIn, err := auth.OrgKeyClient(apiURL)
		if err != nil {
			return "", "", fmt.Errorf("--router %s is a hosted router; sign in with `dari auth login` first: %w", choice.name, err)
		}
		client = signedIn
		path = "/v1/organizations/current/routers/" + url.PathEscape(choice.name) + "/spec?format=yaml"
	}
	var spec []byte
	if err := client.Do(ctx, http.MethodGet, path, nil, &spec); err != nil {
		if he := api.AsHTTPError(err); he != nil && he.Status == http.StatusNotFound && !choice.routerID() {
			return "", "", fmt.Errorf("no template %q; list them with `dari router experiments`", choice.name)
		}
		return "", "", api.HumanError(err)
	}
	return string(spec), choice.name, nil
}

func setKey(m map[string]string, key, value string) map[string]string {
	if m == nil {
		m = map[string]string{}
	}
	m[key] = value
	return m
}
