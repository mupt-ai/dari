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

	"github.com/mupt-ai/dari-cli/internal/api"
	"github.com/mupt-ai/dari-cli/internal/auth"
	"github.com/mupt-ai/dari-cli/internal/cli/agents"
	"github.com/mupt-ai/dari-cli/internal/cli/agents/claude"
	"github.com/mupt-ai/dari-cli/internal/cli/agents/codex"
	"github.com/mupt-ai/dari-cli/internal/cli/agents/muse"
	"github.com/mupt-ai/dari-cli/internal/cli/agents/opencode"
	"github.com/mupt-ai/dari-cli/internal/cli/agents/pi"
	"github.com/mupt-ai/dari-cli/internal/state"
)

const (
	routingBaseURL = "https://routing.dari.dev"
)

// agentLaunchers maps each agent subcommand to its help text. Execute
// dispatches them before Cobra parses anything, so every following argument
// reaches the agent untouched. Cobra only sees them when a Dari flag comes
// first, which would be dropped, so those commands refuse to run.
var agentLaunchers = map[string]string{
	"claude":   "Launch Claude Code through Dari; forward all following arguments (--connect manages subscriptions and provider keys, --setup configures the Claude app)",
	"codex":    "Launch Codex through Dari; forward all following arguments (--connect manages subscriptions and provider keys, --setup configures the Codex app)",
	"opencode": "Launch OpenCode through Dari; forward all following arguments (--connect manages subscriptions and provider keys)",
	"pi":       "Launch Pi through Dari; forward all following arguments (--connect manages subscriptions and provider keys)",
	"muse":     "Launch Muse Code through Dari; forward all following arguments (--connect manages subscriptions and provider keys)",
	"openclaw": "Set OpenClaw up to route through Dari, then launch it; forward all following arguments (--connect manages subscriptions and provider keys, --setup only sets up, --remove-setup undoes it)",
	"hermes":   "Set Hermes Agent up to route through Dari, then launch it; forward all following arguments (--connect manages subscriptions and provider keys, --setup only sets up, --remove-setup undoes it)",
}

// agentConnectFlag opens the subscription list before launching. Dari removes
// it, so the agent never sees it.
const agentConnectFlag = "--connect"

// agentSetupFlag writes Dari into the agent's own config so its desktop app,
// which never runs through the launcher, routes through Dari too.
// agentRemoveSetupFlag undoes it.
const (
	agentSetupFlag       = "--setup"
	agentRemoveSetupFlag = "--remove-setup"
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
	name        string
	args        []string
	connect     bool
	setup       bool
	removeSetup bool
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
		if arg == agentConnectFlag {
			launch.connect = true
			continue
		}
		if arg == agentSetupFlag {
			launch.setup = true
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
	if launch.setup || launch.removeSetup {
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

	key := "unused"
	baseURL := routingBaseURL
	var models agents.Models
	if !agents.OnlyRequestsInfo(launch.args) {
		key, baseURL, models, err = resolveAgentRouting(ctx, launch, stdin, stderr)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}

	if launchSetsUpAgent[launch.name] && !agents.OnlyRequestsInfo(launch.args) {
		if err := applyAgentSetup(ctx, launch.name, key, baseURL, models); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		agentStep(stderr, fmt.Sprintf("%s routes through Dari, starting on %s; `dari %s %s` undoes it", agentApps[launch.name].name, models.Default(), launch.name, agentRemoveSetupFlag))
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
// Otherwise it signs in, sets up the agent's router, and uses that router.
func resolveAgentRouting(ctx context.Context, launch agentLaunch, stdin io.Reader, stderr io.Writer) (string, string, agents.Models, error) {
	gateway, err := gatewayFromEnv()
	if err != nil {
		return "", "", agents.Models{}, err
	}
	if gateway != nil {
		if launch.connect {
			return "", "", agents.Models{}, fmt.Errorf("--connect manages hosted accounts and is not available with %s; use `dari credentials subscription connect`", gatewayURLEnv)
		}
		models, err := routerModels(ctx, gateway.url, gateway.key)
		if err != nil {
			return "", "", agents.Models{}, err
		}
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
	if launch.connect {
		if access.keysAdded, err = connectAgentSubscriptionsOnRequest(ctx, launch.name, access, stdin, stderr); err != nil {
			return "", "", agents.Models{}, err
		}
	}
	routerID, err := ensureAgentRouter(ctx, launch.name, access, stdin, stderr)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	baseURL := agentRoutingBaseURL(routerID)
	models, err := routerModels(ctx, baseURL, access.key)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	// Without the Autorouting plan the launch starts on the router's first
	// model; --connect is where the plan is bought.
	if !models.Routing && len(models.Enabled) > 0 {
		agentPrintln(stderr, fmt.Sprintf("Starting on %s. Switch models with /model, or run `dari %s --connect` to get auto-routing.", models.Default(), launch.name))
	}
	return access.key, baseURL, models, nil
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
		// Launches run on the setup written into the agent's own config.
	default:
		return agents.Command{}, fmt.Errorf("unsupported coding agent %q", launch.name)
	}
	return command, nil
}

func agentRoutingBaseURL(routerID string) string {
	baseURL := routingBaseURL
	if routerID != "" && routerID != "default" {
		baseURL += "/" + routerID
	}
	return baseURL
}
