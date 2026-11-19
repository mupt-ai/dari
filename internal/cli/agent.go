package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/claude"
	"github.com/mupt-ai/dari/internal/cli/agents/codex"
	"github.com/mupt-ai/dari/internal/cli/agents/muse"
	"github.com/mupt-ai/dari/internal/cli/agents/opencode"
	"github.com/mupt-ai/dari/internal/cli/agents/pi"
	"github.com/mupt-ai/dari/internal/state"
)

const (
	routingBaseURL = "https://routing.dari.dev"
)

// agentLaunchers maps each agent subcommand to its help text. Execute
// dispatches them before Cobra parses anything, so every following argument
// reaches the agent untouched. Cobra only sees them when a Dari flag comes
// first, which would be dropped, so those commands refuse to run.
var agentLaunchers = map[string]string{
	"claude":   "Launch Claude Code through Dari; forward all following arguments (--setup-cli sets up plain `claude`, --setup-desktop the Claude app)",
	"codex":    "Launch Codex through Dari; forward all following arguments (--setup-cli or --setup-desktop sets up plain `codex` and the Codex app, which share a config)",
	"opencode": "Launch OpenCode through Dari; forward all following arguments (--setup-cli sets up plain `opencode`)",
	"pi":       "Launch Pi through Dari; forward all following arguments (--setup-cli sets up plain `pi`)",
	"muse":     "Launch Muse Code through Dari; forward all following arguments",
	"openclaw": "Launch OpenClaw, set up once with --setup-cli to route through Dari; forward all following arguments",
	"hermes":   "Launch Hermes Agent, set up once with --setup-cli to route through Dari; forward all following arguments",
}

// A launch routes only its own session and leaves the agent's config alone.
// agentSetupCLIFlag writes Dari into that config so the agent run directly
// routes through Dari too; agentSetupDesktopFlag does the same for its
// desktop app. Pass both for both. agentRemoveSetupFlag undoes either.
const (
	agentSetupCLIFlag     = "--setup-cli"
	agentSetupDesktopFlag = "--setup-desktop"
	agentRemoveSetupFlag  = "--remove-setup"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, _ *globalFlags) {
		for name, short := range agentLaunchers {
			root.AddCommand(&cobra.Command{
				Use:                name + " [args...]",
				Short:              short,
				DisableFlagParsing: true,
				RunE: func(*cobra.Command, []string) error {
					return fmt.Errorf("%q must be the first argument so Dari can forward all agent arguments", name)
				},
			})
		}
	})
}

type agentLaunch struct {
	name         string
	args         []string
	setupCLI     bool
	setupDesktop bool
	removeSetup  bool
}

func (l agentLaunch) setup() bool { return l.setupCLI || l.setupDesktop }

// setupFlags are the setup flags as the user would type them again.
func (l agentLaunch) setupFlags() string {
	flags := []string{}
	if l.setupCLI {
		flags = append(flags, agentSetupCLIFlag)
	}
	if l.setupDesktop {
		flags = append(flags, agentSetupDesktopFlag)
	}
	return strings.Join(flags, " ")
}

func parseAgentLaunch(args []string) (agentLaunch, bool) {
	if len(args) == 0 {
		return agentLaunch{}, false
	}

	if _, ok := agentLaunchers[args[0]]; !ok {
		return agentLaunch{}, false
	}
	launch := agentLaunch{name: args[0], args: []string{}}
	for i, arg := range args[1:] {
		if arg == "--" {
			launch.args = append(launch.args, args[1+i:]...)
			break
		}
		if arg == agentSetupCLIFlag {
			launch.setupCLI = true
			continue
		}
		if arg == agentSetupDesktopFlag {
			launch.setupDesktop = true
			continue
		}
		if arg == agentRemoveSetupFlag {
			launch.removeSetup = true
			continue
		}
		launch.args = append(launch.args, arg)
	}
	return launch, true
}

func runAgentLaunch(ctx context.Context, launch agentLaunch, stdin io.Reader, stdout, stderr io.Writer) int {
	if launch.setup() || launch.removeSetup {
		if err := runAgentSetup(ctx, launch, stdin, stderr); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		return 0
	}
	path, err := agentExecutable(launch.name)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 127
	}

	if routesOnlyWhenSetUp[launch.name] && !agents.OnlyRequestsInfo(launch.args) {
		if !gatewayAgentSetUp(ctx, launch.name) {
			fmt.Fprintf(stderr, "%s routes through Dari only once it is set up; run `dari %s %s` first\n", agentApps[launch.name].name, launch.name, agentSetupCLIFlag)
			return 1
		}
		// Its config may name the local gateway, which launches start as they
		// do for every other agent. It routes on its own config, not on the
		// current mode, so a gateway that cannot be read or started only warns.
		if gw, err := currentGateway(); err == nil && gw != nil && gw.local {
			if err := gw.ensure(ctx, stderr); err != nil {
				agentStep(stderr, fmt.Sprintf("Could not start the local gateway (%v); run `dari gateway start`", err))
			}
		}
	}

	key := "unused"
	baseURL := routingBaseURL
	var models agents.Models
	// OpenClaw and Hermes route on the setup in their own config, so their
	// launches need no routing of their own.
	if !agents.OnlyRequestsInfo(launch.args) && !routesOnlyWhenSetUp[launch.name] {
		key, baseURL, models, err = resolveAgentRouting(ctx, &launch, stdin, stderr)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}

	// Status lines render in the agent and in this launcher (Codex, Muse); both
	// read this, and a hosted launch clears one inherited from a gateway session.
	noActivityLink := ""
	if !hostedRouting(baseURL) {
		noActivityLink = "1"
	}
	if err := os.Setenv(agents.NoActivityLinkEnv, noActivityLink); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	command, err := buildAgentCommand(path, launch, key, baseURL, models)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	// Read cleanup at return time: catalog and display setup compose resources.
	defer func() {
		if command.Cleanup != nil {
			command.Cleanup()
		}
	}()
	if launch.name == "codex" && !agents.OnlyRequestsInfo(launch.args) {
		if err := codex.PrepareCatalog(ctx, &command, key, baseURL, models); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if err := codex.PrepareStatus(ctx, &command, launch.args, key, baseURL); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	if launch.name == "muse" && !agents.OnlyRequestsInfo(launch.args) {
		if err := muse.Prepare(&command, launch.args, key, baseURL); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	if command.CanReplace() && inheritsStdio(stdin, stdout, stderr) {
		// The agent takes the launcher's place, so the pane's foreground process
		// is the agent itself. Environ dedupes the variables as os/exec would,
		// and a failed exec reports exactly what a failed start does.
		argv := append([]string{command.Path}, command.Args...)
		env := (&exec.Cmd{Env: command.Env}).Environ()
		if err := agents.ReplaceProcess(command.Path, argv, env); err != nil {
			fmt.Fprintf(stderr, "start %s: %v\n", launch.name, &os.PathError{Op: "fork/exec", Path: command.Path, Err: err})
			return 1
		}
	}
	cmd := exec.CommandContext(ctx, command.Path, command.Args...)
	cmd.Env = command.Env
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	run := cmd.Run
	if command.Run != nil {
		run = func() error { return command.Run(cmd) }
	}
	if err := run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		fmt.Fprintf(stderr, "start %s: %v\n", launch.name, err)
		return 1
	}
	return 0
}

// inheritsStdio reports whether the agent would use the launcher's own
// standard streams, which only a process replacement hands over as they are.
func inheritsStdio(stdin io.Reader, stdout, stderr io.Writer) bool {
	return stdin == os.Stdin && stdout == os.Stdout && stderr == os.Stderr
}

// resolveAgentRouting returns the key and base URL a launch routes through. In
// gateway mode it makes no hosted calls and offers the gateway's models.
// Otherwise it signs in, sets up the agent's router, and uses that router; an
// experimental router's flag, which it takes out of the launch's arguments,
// launches on that router instead.
func resolveAgentRouting(ctx context.Context, launch *agentLaunch, stdin io.Reader, stderr io.Writer) (string, string, agents.Models, error) {
	gateway, err := agentGateway(ctx, stdin, stderr)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	if gateway != nil {
		models, err := gatewayAgentModels(ctx, gateway, *launch, stdin, stderr)
		if err != nil {
			return "", "", agents.Models{}, err
		}
		// The launch starts on the user's saved pick; say so accurately.
		models.Saved = savedAgentModel(launch.name)
		models = reportGatewayModels(ctx, gateway, launch.name, models, stderr)
		return gateway.key, gateway.url, models, nil
	}
	// Onboarding pages follow one another on the alternate screen; their
	// summary prints once setup is done.
	holdAgentScreen()
	defer releaseAgentScreen()
	access, err := resolveAgentRoutingAccess(ctx, stdin, stderr)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	client, err := auth.OrgKeyClient(access.apiURL)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	experiment, err := takeAgentExperiment(ctx, client, launch, stderr)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	var routerID string
	if experiment != nil {
		routerID, err = applyAgentExperiment(ctx, client, launch.name, *experiment, stdin, stderr)
	} else {
		routerID, err = ensureAgentRouter(ctx, launch.name, access, stdin, stderr)
	}
	if err != nil {
		return "", "", agents.Models{}, err
	}
	baseURL := agentRoutingBaseURL(routerID)
	// Hosted routers fall back to managed keys for a plan's provider, so they
	// list its models for every client; naming the agent there would also
	// drop them while the plan is held. Only gateways need the agent.
	models, err := routerModels(ctx, baseURL, access.key, "")
	if err != nil {
		return "", "", agents.Models{}, err
	}
	models.Saved = savedAgentModel(launch.name)
	// Without the Autorouting plan the launch starts on the router's first
	// model; the Accounts page is where the plan is bought.
	if !models.Routing && len(models.Enabled) > 0 {
		agentPrintln(stderr, fmt.Sprintf("Starting on %s. Switch models with /model, or run `dari accounts` to get auto-routing.", startModel(launch.name, models)))
	}
	reportAgentModels(launch.name, models, true, stderr)
	return access.key, baseURL, models, nil
}

// startModel is the model a launch of agent starts on. Claude Code keeps the
// user's pick even while the router cannot serve it.
func startModel(agent string, models agents.Models) string {
	if agent == "claude" {
		return claude.StartModel(models)
	}
	return models.Default()
}

// reportAgentModels warns about model choices the router cannot serve.
func reportAgentModels(agent string, models agents.Models, hosted bool, stderr io.Writer) {
	if agent != "claude" {
		return
	}
	for _, warning := range claude.Warnings(models, hosted) {
		agentPrintln(stderr, warning)
	}
}

func agentExecutable(name string) (string, error) {
	envName := "DARI_" + strings.ToUpper(name) + "_PATH"
	if path := strings.TrimSpace(os.Getenv(envName)); path != "" {
		resolved, err := exec.LookPath(path)
		if err != nil {
			return "", fmt.Errorf("%s does not point to an executable file", envName)
		}
		return resolved, nil
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("%s is not installed or is not on PATH", name)
	}
	return path, nil
}

// launchedRoutingKeyEnv marks a DARI_ROUTING_API_KEY that a Dari launch set
// for its agent. A launch from inside that agent resolves the current org's
// key instead, since the inherited key belongs to the org the parent started in.
const launchedRoutingKeyEnv = "DARI_ROUTING_API_KEY_FROM_LAUNCH"

// explicitRoutingKey returns the DARI_ROUTING_API_KEY the user set, ignoring
// one inherited from a parent launch.
func explicitRoutingKey(stderr io.Writer) string {
	if os.Getenv(launchedRoutingKeyEnv) != "" {
		return ""
	}
	key := strings.TrimSpace(os.Getenv(agents.RoutingAPIKeyEnv))
	if key != "" {
		agentStep(stderr, "Using "+agents.RoutingAPIKeyEnv+" from the environment; unset it to use your current org's key")
	}
	return key
}

func resolveAgentRoutingKey(ctx context.Context, stdin io.Reader, stderr io.Writer) (string, error) {
	if key := explicitRoutingKey(stderr); key != "" {
		return key, nil
	}

	apiURL, err := (&globalFlags{}).resolveAPIURL()
	if err != nil {
		return "", err
	}
	scope, err := agentKeyScope(ctx, apiURL, stdin, stderr)
	if err != nil {
		return "", err
	}
	return resolveAgentRoutingKeyForScope(ctx, apiURL, scope, stderr)
}

func resolveAgentRoutingKeyForScope(
	ctx context.Context,
	apiURL string,
	scope string,
	stderr io.Writer,
) (string, error) {
	if key := explicitRoutingKey(stderr); key != "" {
		return key, nil
	}
	key, created, err := state.EnsureRoutingKey(scope, func() (string, error) {
		return createAgentRoutingKey(ctx, apiURL)
	})
	if err != nil {
		return "", err
	}
	if created {
		agentStep(stderr, "Routing key created")
	}
	return key, nil
}

func agentKeyScope(ctx context.Context, apiURL string, stdin io.Reader, stderr io.Writer) (string, error) {
	if managementKey := auth.EnvAPIKeyValue(); managementKey != "" {
		digest := sha256.Sum256([]byte(managementKey))
		return apiURL + "|key:" + hex.EncodeToString(digest[:8]), nil
	}

	s, err := state.Load()
	if err != nil {
		return "", err
	}
	if !api.URLsMatch(s.APIURL, apiURL) || s.CurrentOrg() == nil {
		if !agentInputIsTerminal(stdin) {
			agentStep(stderr, "Routing is set to hosted Dari, which needs a browser sign-in. For a local gateway run `dari gateway setup --mode local`")
		}
		s, err = loginWithBrowser(ctx, apiURL, stdin, stderr, "Sign in to set up your coding agents")
		if err != nil {
			return "", err
		}
	}
	org := s.CurrentOrg()
	if org == nil {
		return "", auth.ErrNoCurrentOrg
	}
	if org.APIKey == "" {
		s, _, err = auth.ListOrganizations(ctx, apiURL)
		if err != nil {
			return "", err
		}
		org = s.CurrentOrg()
		if org == nil {
			return "", auth.ErrNoCurrentOrg
		}
	}
	return apiURL + "|org:" + org.ID, nil
}

func createAgentRoutingKey(ctx context.Context, apiURL string) (string, error) {
	key, err := issueAgentRoutingKey(ctx, apiURL)
	httpErr := api.AsHTTPError(err)
	if httpErr != nil && httpErr.Status == http.StatusUnauthorized && auth.EnvAPIKeyValue() == "" {
		s, loadErr := state.Load()
		if loadErr == nil && s.CurrentOrg() != nil {
			if _, refreshErr := auth.SwitchOrganization(ctx, apiURL, s.CurrentOrgID); refreshErr == nil {
				key, err = issueAgentRoutingKey(ctx, apiURL)
			}
		}
	}
	if err != nil {
		return "", api.HumanError(err)
	}
	if strings.TrimSpace(key) == "" {
		return "", errors.New("Dari returned an empty Routing key")
	}
	return key, nil
}

func issueAgentRoutingKey(ctx context.Context, apiURL string) (string, error) {
	client, err := auth.OrgKeyClient(apiURL)
	if err != nil {
		return "", err
	}
	hostname, _ := os.Hostname()
	label := "Dari coding agents"
	if hostname != "" {
		label += " (" + hostname + ")"
	}
	var issued struct {
		APIKey string `json:"api_key"`
	}
	err = client.Do(
		ctx,
		http.MethodPost,
		"/v1/organizations/current/api-keys",
		map[string]string{"label": label, "key_type": "routing"},
		&issued,
	)
	return issued.APIKey, err
}

func buildAgentCommand(path string, launch agentLaunch, key, baseURL string, models agents.Models) (agents.Command, error) {
	command := agents.Command{Path: path, Args: launch.args, Env: agents.WithEnvironment(os.Environ(), map[string]string{agents.RoutingAPIKeyEnv: key, launchedRoutingKeyEnv: "1"})}
	switch launch.name {
	case "claude":
		if err := claude.Configure(&command, key, baseURL, models); err != nil {
			return agents.Command{}, err
		}
	case "codex":
		codex.Configure(&command, baseURL, models)
	case "opencode":
		if err := opencode.Configure(&command, baseURL, models); err != nil {
			return agents.Command{}, err
		}
	case "pi":
		if err := pi.Configure(&command, baseURL, models); err != nil {
			return agents.Command{}, err
		}
	case "muse":
		muse.Configure(&command, key, models)
	case "openclaw", "hermes":
		// Launches run on the setup --setup-cli wrote into the agent's own config.
	default:
		return agents.Command{}, fmt.Errorf("unsupported coding agent %q", launch.name)
	}
	return command, nil
}

// hostedRouting reports whether baseURL is hosted Dari routing, whose
// requests appear on the Activity dashboard.
func hostedRouting(baseURL string) bool {
	return baseURL == routingBaseURL || strings.HasPrefix(baseURL, routingBaseURL+"/")
}

func agentRoutingBaseURL(routerID string) string {
	baseURL := routingBaseURL
	if routerID != "" && routerID != "default" {
		baseURL += "/" + routerID
	}
	return baseURL
}
