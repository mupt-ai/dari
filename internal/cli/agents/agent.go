package agents

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Agent is one coding agent Dari launches and sets up. Each agent's package
// exports one, and the CLI lists them in one place.
type Agent struct {
	// Name is its `dari` subcommand and the executable it runs.
	Name string
	// Label names it to people.
	Label string
	// Help is the `dari <name>` command's help text.
	Help string
	// CodingAgent identifies it in the organization's router assignments.
	CodingAgent string
	// Suggestion is the model preset the model picker starts from, the same
	// one the frontend shows.
	Suggestion string
	// Subscriptions are the personal subscriptions it can use, by provider ID,
	// its own first: a ChatGPT plan serves OpenAI models to any client, while
	// Claude Code and Muse Code plans serve only their own agent.
	Subscriptions []string
	// RouterKey names the router it sets up for itself; empty shares the
	// organization's default router.
	RouterKey string
	// SessionEnv names the variable that holds its session ID in its own
	// shell commands' environment. Its launches report the commits those
	// commands make for that session.
	SessionEnv string
	// HandlesInterrupt marks an agent that Ctrl-C interrupts (a turn, or the
	// agent itself), so its launcher outlives the signal and cleans up after
	// the agent exits.
	HandlesInterrupt bool

	// Configure points a launch at Dari's routing. It is nil for an agent
	// whose sessions all run in one long-lived gateway reading its own
	// config: a launch cannot route only itself, so the agent routes through
	// Dari once `dari setup <name> --cli` has written that config, and a
	// launch before then is refused rather than run unrouted. ownKey is a
	// launch whose key is not the hosted routing key setup saves, such as one
	// through this computer's gateway.
	Configure func(command *Command, key, baseURL string, models Models, ownKey bool) error
	// Prepare finishes a launch that runs a session, after Configure.
	Prepare func(ctx context.Context, command *Command, args []string, key, baseURL string, models Models) error
	// StartModel is the model a launch starts on; nil starts on
	// models.Default().
	StartModel func(models Models) string
	// Warnings are about model choices the router cannot serve.
	Warnings func(models Models, hosted bool) []string
	// SavedModel is the model the agent saved as the user's last pick, or "".
	SavedModel func() string
	// Setup writes Dari into the agent's own config; nil when Dari sets up
	// none.
	Setup *Setup
	// Local configures a launch on a model served on this computer.
	Local func(ctx context.Context, command Command, local Local) (Command, error)
	// LocalContextWindow is the context window a local launch needs at least;
	// 0 takes the engine's own.
	LocalContextWindow int
	// Traces reads the sessions the agent keeps on this computer; nil when
	// `dari traces import` cannot.
	Traces *Traces
}

// RoutesOnlyWhenSetUp reports whether the agent routes through Dari only on
// the setup in its own config. See Configure.
func (a Agent) RoutesOnlyWhenSetUp() bool { return a.Configure == nil }

// Setup writes Dari into the config the agent reads when run directly
// (`dari setup <agent> --cli`) and the one its desktop app reads (--desktop).
type Setup struct {
	// Applies says how a change takes effect in the agent run directly.
	Applies string
	// Desktop names its desktop app ("" when it has none), and DesktopApplies
	// how a change takes effect there.
	Desktop, DesktopApplies string
	// SharedConfig marks a desktop app that reads the CLI's own config, so
	// setting up either sets up both.
	SharedConfig bool
	// IsSetUp reports whether the agent run directly, and its desktop app,
	// have Dari set up.
	IsSetUp func(ctx context.Context) (cli, desktop bool)
	// Save writes Dari into the config the agent reads when run directly, so
	// it routes through Dari and keeps the user's model pick.
	Save func(ctx context.Context, key, baseURL string, models Models) error
	// SaveDesktop writes Dari into the desktop app's own config; nil when the
	// app reads the CLI's.
	SaveDesktop func(key, baseURL string, models Models) error
	// Remove takes Dari out of both, reporting whether either had it.
	Remove func(ctx context.Context) (bool, error)
}

// Local is a launch on a model served on this computer.
type Local struct {
	Model string
	// Endpoint is the model's OpenAI-compatible API, ending in /v1.
	Endpoint string
	// Window is the model's context window, and Output the most it writes
	// in one response.
	Window, Output int
	// Dir is the launch's own directory, removed when it ends.
	Dir string
	// Config writes one of the launch's config files into Dir and returns its
	// path.
	Config func(name string, value any) (string, error)
	// Bridge serves the model over the Responses and Messages APIs, for agents
	// that speak only those, and returns that server's URL and key.
	Bridge func() (url, key string, err error)
}

// Executable is the agent executable a launch runs: the one
// DARI_<NAME>_PATH names, else name on PATH.
func Executable(name string) (string, error) {
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
