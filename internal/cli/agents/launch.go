// Package agents holds what every coding-agent launcher shares: the command
// being built, argument and environment helpers, and the routing status each
// agent shows in its UI. Each agent's own setup lives in a subpackage.
package agents

import (
	"os/exec"
	"slices"
	"strings"
)

const (
	RoutingAPIKeyEnv = "DARI_ROUTING_API_KEY"
	GatewayURLEnv    = "DARI_GATEWAY_URL"
	// NoActivityLinkEnv is set by a launch whose requests do not go through
	// hosted Dari, such as one through a local or self-hosted gateway: the
	// Activity dashboard never sees them, so status lines leave out its link.
	NoActivityLinkEnv = "DARI_NO_ACTIVITY_LINK"
	RoutingModel      = "dari/routing"
	// ClientHarnessHeader names the coding agent a model list or request is
	// for, so a gateway serves the models it lists for that agent.
	ClientHarnessHeader = "x-dari-client-harness"
	// ExplicitModelPrefix names one enabled model, served without routing.
	ExplicitModelPrefix = "dari/model/"
)

// Models is the menu a launcher offers in its agent's model picker:
// dari/routing when the organization has the Autorouting plan, then each
// model enabled on the router.
type Models struct {
	Routing bool
	Enabled []string
	// Unavailable are models the user chose that no connected account or API
	// key serves yet. They are not in Menu; agents whose picker takes labels
	// list them with one, so every chosen model is visible.
	Unavailable []string
	// Saved is the model the agent itself saved as the user's last pick (its
	// /model choice). A launch starts on it while it is on the menu.
	Saved string
}

// Default is the model a launch starts on: the user's saved pick while the
// router offers it, else routing when it is available, else the router's
// first model. Launches that never resolved a router keep dari/routing.
func (m Models) Default() string {
	if m.Saved != "" && slices.Contains(m.Menu(), m.Saved) {
		return m.Saved
	}
	return m.Stable()
}

// Stable is the model that never follows a /model pick: routing when it is
// available, else the router's first model. An agent's aliases and subagents
// are pinned to it, because a running session cannot update those pins when
// the user switches models.
func (m Models) Stable() string {
	if m.Routing || len(m.Enabled) == 0 {
		return RoutingModel
	}
	return ExplicitModelPrefix + m.Enabled[0]
}

// Menu lists every model id a launch can switch to, default first.
func (m Models) Menu() []string {
	menu := make([]string, 0, len(m.Enabled)+1)
	if m.Routing || len(m.Enabled) == 0 {
		menu = append(menu, RoutingModel)
	}
	for _, model := range m.Enabled {
		menu = append(menu, ExplicitModelPrefix+model)
	}
	return menu
}

// Command is the agent process to start. Cleanup removes anything the
// launcher created for it, such as temporary settings or plugins. Run, when
// set, starts the process in place of running it directly, for launchers that
// own the agent's terminal.
type Command struct {
	Path    string
	Args    []string
	Env     []string
	Cleanup func()
	Run     func(*exec.Cmd) error
}

// CanReplace reports whether the launcher can hand its process over to the
// agent: the launch keeps no state in the launcher, such as a cleanup for its
// files or a proxy it serves, and nothing wraps the process.
func (c Command) CanReplace() bool {
	return CanReplaceProcess && c.Cleanup == nil && c.Run == nil
}

// InsertBeforeDoubleDash adds arguments before any `--`, so they are read as
// options rather than passed through to a prompt.
func InsertBeforeDoubleDash(args, inserted []string) []string {
	at := len(args)
	for i, arg := range args {
		if arg == "--" {
			at = i
			break
		}
	}
	result := make([]string, 0, len(args)+len(inserted))
	result = append(result, args[:at]...)
	result = append(result, inserted...)
	result = append(result, args[at:]...)
	return result
}

func ArgsContainFlag(args []string, name string) bool {
	for _, arg := range args {
		if arg == "--" {
			return false
		}
		if arg == name || strings.HasPrefix(arg, name+"=") {
			return true
		}
	}
	return false
}

// OnlyRequestsInfo reports whether a launch only asks for help or a version,
// which needs neither sign-in nor setup.
func OnlyRequestsInfo(args []string) bool {
	for _, arg := range args {
		if arg == "--" {
			break
		}
		switch arg {
		case "--help", "-h", "--version", "-V", "-v":
			return true
		}
	}
	return len(args) > 0 && args[0] == "help"
}

func WithEnvironment(base []string, values map[string]string) []string {
	result := make([]string, 0, len(base)+len(values))
	for _, entry := range base {
		name, _, _ := strings.Cut(entry, "=")
		if _, replaced := values[name]; !replaced {
			result = append(result, entry)
		}
	}
	for name, value := range values {
		result = append(result, name+"="+value)
	}
	return result
}

func WithoutEnvironment(env []string, name string) []string {
	result := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, name+"=") {
			result = append(result, entry)
		}
	}
	return result
}

func EnvironmentValue(env []string, name string) string {
	prefix := name + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix)
		}
	}
	return ""
}
