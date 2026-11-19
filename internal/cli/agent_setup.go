package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/claude"
	"github.com/mupt-ai/dari/internal/cli/agents/codex"
	"github.com/mupt-ai/dari/internal/cli/agents/hermes"
	"github.com/mupt-ai/dari/internal/cli/agents/openclaw"
	"github.com/mupt-ai/dari/internal/cli/agents/opencode"
	"github.com/mupt-ai/dari/internal/cli/agents/pi"
)

// agentApp names what setup configures for an agent and how each change
// takes effect: --setup-cli the agent run directly, --setup-desktop its
// desktop app ("" when it has none).
type agentApp struct {
	name           string
	applies        string
	desktop        string
	desktopApplies string
	// sharedConfig marks a desktop app that reads the CLI's own config, so
	// setting up either sets up both.
	sharedConfig bool
}

var agentApps = map[string]agentApp{
	"claude":   {name: "Claude Code", applies: "new Claude Code sessions pick it up", desktop: "the Claude app", desktopApplies: "restart the Claude app to apply it there"},
	"codex":    {name: "Codex", applies: "new Codex sessions pick it up", desktop: "the Codex app", desktopApplies: "restart the Codex app to apply it there", sharedConfig: true},
	"pi":       {name: "Pi", applies: "new Pi sessions pick it up"},
	"opencode": {name: "OpenCode", applies: "new OpenCode sessions pick it up"},
	"openclaw": {name: "OpenClaw", applies: "its gateway picks it up without a restart"},
	"hermes":   {name: "Hermes Agent", applies: "new sessions use it; run `hermes gateway restart` for messaging sessions already open"},
}

// target names what a setup of cli and desktop covers, and how it takes effect.
func (app agentApp) target(cli, desktop bool) (string, string) {
	if app.sharedConfig {
		cli, desktop = true, true
	}
	names, applies := []string{}, []string{}
	if cli {
		names, applies = append(names, app.name), append(applies, app.applies)
	}
	if desktop && app.desktop != "" {
		names, applies = append(names, app.desktop), append(applies, app.desktopApplies)
	}
	return strings.Join(names, " and "), strings.Join(applies, "; ")
}

// routesOnlyWhenSetUp marks agents whose sessions all run in one long-lived
// gateway that reads the agent's own config, so a launch cannot route only
// itself: they route through Dari once --setup-cli has written that config,
// and a launch before then is refused rather than run unrouted.
var routesOnlyWhenSetUp = map[string]bool{"openclaw": true, "hermes": true}

// gatewayAgentSetUp reports whether OpenClaw or Hermes has Dari set up.
func gatewayAgentSetUp(ctx context.Context, name string) bool {
	switch name {
	case "openclaw":
		executable, err := agentExecutable(name)
		return err == nil && openclaw.IsSetUp(ctx, executable)
	case "hermes":
		config, err := hermesConfigPath(ctx)
		return err == nil && hermes.IsSetUp(config)
	}
	return false
}

// runAgentSetup writes, or with --remove-setup removes, the config the agent
// reads when run directly (--setup-cli) or its desktop app reads
// (--setup-desktop). Setup runs the launcher's onboarding first, so it uses
// the same router, key, and model menu as `dari <agent>`.
func runAgentSetup(ctx context.Context, launch agentLaunch, stdin io.Reader, stderr io.Writer) error {
	app, ok := agentApps[launch.name]
	if !ok {
		names := make([]string, 0, len(agentApps))
		for name := range agentApps {
			names = append(names, name)
		}
		slices.Sort(names)
		return fmt.Errorf("%s and %s are only available for %s", agentSetupCLIFlag, agentRemoveSetupFlag, strings.Join(names, ", "))
	}
	if launch.setup() && launch.removeSetup {
		return fmt.Errorf("use either %s or setup, not both", agentRemoveSetupFlag)
	}
	if launch.setupDesktop && app.desktop == "" {
		return fmt.Errorf("%s has no desktop app; use `dari %s %s`", app.name, launch.name, agentSetupCLIFlag)
	}
	if len(launch.args) > 0 {
		return errors.New("setup does not take agent arguments")
	}
	if launch.removeSetup {
		// Removal undoes both, whichever was set up.
		target, applies := app.target(true, true)
		removed, err := removeAgentSetup(ctx, launch.name)
		if err != nil {
			return err
		}
		if !removed {
			agentStep(stderr, "Dari is not set up in "+target)
			return nil
		}
		agentStep(stderr, "Removed Dari from "+target+"; "+applies)
		return nil
	}
	key, baseURL, models, err := resolveAgentRouting(ctx, &launch, stdin, stderr)
	if err != nil {
		return err
	}
	if err := writeAgentSetup(ctx, launch.name, launch.setupCLI, launch.setupDesktop, key, baseURL, models); err != nil {
		return err
	}
	target, applies := app.target(launch.setupCLI, launch.setupDesktop)
	agentStep(stderr, fmt.Sprintf("Dari is set up in %s, starting on %s; %s", target, startModel(launch.name, models), applies))
	agentStep(stderr, fmt.Sprintf("Run `dari %s %s` again after changing the router's models, or `dari %s %s` to undo", launch.name, launch.setupFlags(), launch.name, agentRemoveSetupFlag))
	return nil
}

// writeAgentSetup writes Dari into the agent's own config (cli) and its
// desktop app's (desktop). Only the Claude app has a config of its own; the
// Codex app reads the CLI's.
func writeAgentSetup(ctx context.Context, name string, cli, desktop bool, key, baseURL string, models agents.Models) error {
	// The app first: it is the step that can refuse (the Claude app lists
	// only Claude models), and nothing is written when it does.
	if desktop && name == "claude" {
		if err := setUpClaudeApp(key, baseURL, models); err != nil {
			return err
		}
	}
	if cli || (desktop && name != "claude") {
		return saveAgentConfig(ctx, name, key, baseURL, models)
	}
	return nil
}

// savedAgentModel is the model the agent saved as the user's last pick, or ""
// for agents that save none.
func savedAgentModel(name string) string {
	switch name {
	case "claude":
		settings, err := claude.SettingsPath()
		if err != nil {
			return ""
		}
		return claude.SavedModel(settings)
	case "codex":
		home, err := codex.Home()
		if err != nil {
			return ""
		}
		return codex.SavedModel(home)
	case "pi":
		dir, err := pi.AgentDir()
		if err != nil {
			return ""
		}
		return pi.SavedModel(dir)
	case "opencode":
		dir, err := opencode.StateDir()
		if err != nil {
			return ""
		}
		return opencode.SavedModel(dir)
	}
	return ""
}

// saveAgentConfig writes Dari into the config the agent reads when run
// directly, so it routes through Dari and keeps the user's model pick. Only
// setup and a routing mode switch write it.
func saveAgentConfig(ctx context.Context, name, key, baseURL string, models agents.Models) error {
	switch name {
	case "claude":
		settings, err := claude.SettingsPath()
		if err != nil {
			return err
		}
		// Without Claude Code on PATH there is no login to keep.
		executable, _ := agentExecutable("claude")
		return claude.CLISetup(settings, executable, baseURL, key, models)
	case "codex":
		// Codex's app and CLI read the same config.toml, so its setup serves both.
		home, err := codex.Home()
		if err != nil {
			return err
		}
		catalog, disableWebSearch, err := codex.Catalog(ctx, key, baseURL, models)
		if err != nil {
			return err
		}
		return codex.Setup(home, baseURL, key, models.Default(), catalog, disableWebSearch, models.RemoteCompaction)
	case "pi":
		dir, err := pi.AgentDir()
		if err != nil {
			return err
		}
		return pi.Setup(dir, baseURL, key, models)
	case "opencode":
		dir, err := opencode.ConfigDir()
		if err != nil {
			return err
		}
		return opencode.Setup(dir, baseURL, key, models)
	case "openclaw":
		executable, err := agentExecutable(name)
		if err != nil {
			return err
		}
		return openclaw.Setup(ctx, executable, baseURL, key, models)
	case "hermes":
		config, err := hermesConfigPath(ctx)
		if err != nil {
			return err
		}
		return hermes.Setup(config, baseURL, key, models)
	}
	return fmt.Errorf("unsupported coding agent %q", name)
}

// setUpClaudeApp writes Dari into the Claude desktop app's configuration.
func setUpClaudeApp(key, baseURL string, models agents.Models) error {
	dir, err := claude.DesktopDir()
	if err != nil {
		return err
	}
	settings, err := claude.SettingsPath()
	if err != nil {
		return err
	}
	return claude.Setup(dir, settings, baseURL, key, models)
}

func removeAgentSetup(ctx context.Context, name string) (bool, error) {
	switch name {
	case "claude":
		dir, err := claude.DesktopDir()
		if err != nil {
			return false, err
		}
		settings, err := claude.SettingsPath()
		if err != nil {
			return false, err
		}
		// Claude Code first, then the app: the app's setup also sets the
		// hint-header variable, which Claude Code's setup may have recorded as
		// already set, and the app's removal clears it.
		cli, err := claude.RemoveCLISetup(settings)
		if err != nil {
			return false, err
		}
		app, err := claude.RemoveSetup(dir, settings)
		return app || cli, err
	case "codex":
		home, err := codex.Home()
		if err != nil {
			return false, err
		}
		return codex.RemoveSetup(home)
	case "pi":
		dir, err := pi.AgentDir()
		if err != nil {
			return false, err
		}
		return pi.RemoveSetup(dir)
	case "opencode":
		dir, err := opencode.ConfigDir()
		if err != nil {
			return false, err
		}
		return opencode.RemoveSetup(dir)
	case "openclaw":
		executable, err := agentExecutable(name)
		if err != nil {
			return false, err
		}
		return openclaw.RemoveSetup(ctx, executable)
	case "hermes":
		config, err := hermesConfigPath(ctx)
		if err != nil {
			return false, err
		}
		return hermes.RemoveSetup(config)
	}
	return false, fmt.Errorf("unsupported coding agent %q", name)
}

func hermesConfigPath(ctx context.Context) (string, error) {
	executable, err := agentExecutable("hermes")
	if err != nil {
		return "", err
	}
	return hermes.ConfigPath(ctx, executable)
}

func capitalized(value string) string {
	if value == "" {
		return value
	}
	return strings.ToUpper(value[:1]) + value[1:]
}

// setUpAgents are the agents whose own config Dari is set up in, in a fixed
// order. OpenClaw and Hermes are only asked when installed.
func setUpAgents(ctx context.Context) []string {
	set := []string{}
	if claudeCLISetUp() || claudeAppSetUp() {
		set = append(set, "claude")
	}
	if home, err := codex.Home(); err == nil && codex.IsSetUp(home) {
		set = append(set, "codex")
	}
	if dir, err := pi.AgentDir(); err == nil && pi.IsSetUp(dir) {
		set = append(set, "pi")
	}
	if dir, err := opencode.ConfigDir(); err == nil && opencode.IsSetUp(dir) {
		set = append(set, "opencode")
	}
	for _, name := range []string{"openclaw", "hermes"} {
		if gatewayAgentSetUp(ctx, name) {
			set = append(set, name)
		}
	}
	return set
}

// moveAgentSetups rewrites every set-up agent's own config for the current
// routing, so `claude`, `codex`, the desktop apps, OpenClaw, and Hermes follow
// a mode switch at once instead of on their next `dari <agent>` launch. An
// agent that cannot move is named with how to finish it; the others still move.
func moveAgentSetups(ctx context.Context, stdin io.Reader, stderr io.Writer) {
	agentNames := setUpAgents(ctx)
	if len(agentNames) == 0 {
		return
	}
	// Hosted routing needs a sign-in, which a switch must not start on its own.
	if gw, err := currentGateway(); err != nil || (gw == nil && !signedIn()) {
		agentStep(stderr, fmt.Sprintf("Set up agents (%s) still route the old way; sign in with `dari auth login`, then run `dari gateway setup --mode hosted` again to move them", strings.Join(agentNames, ", ")))
		return
	}
	for _, name := range agentNames {
		// Claude Code and the Claude app are set up apart; each moves only if set up.
		cli, desktop := true, false
		if name == "claude" {
			cli, desktop = claudeCLISetUp(), claudeAppSetUp()
		}
		target, applies := agentApps[name].target(cli, desktop)
		if err := moveAgentSetup(ctx, name, cli, desktop, stdin, stderr); err != nil {
			flags := agentLaunch{setupCLI: cli, setupDesktop: desktop}.setupFlags()
			agentPrintln(stderr, fmt.Sprintf("%s still routes the old way (%v); run `dari %s %s`", capitalized(target), err, name, flags))
			continue
		}
		agentStep(stderr, capitalized(target)+" moved; "+applies)
	}
}

// claudeCLISetUp reports whether Claude Code has Dari set up.
func claudeCLISetUp() bool {
	settings, err := claude.SettingsPath()
	return err == nil && claude.IsCLISetUp(settings)
}

// claudeAppSetUp reports whether the Claude app has Dari set up.
func claudeAppSetUp() bool {
	dir, err := claude.DesktopDir()
	return err == nil && claude.IsSetUp(dir)
}

func moveAgentSetup(ctx context.Context, name string, cli, desktop bool, stdin io.Reader, stderr io.Writer) error {
	key, baseURL, models, err := existingAgentRouting(ctx, name, stdin, stderr)
	if err != nil {
		return err
	}
	// Keep the user's last model pick, as a launch does.
	models.Saved = savedAgentModel(name)
	return writeAgentSetup(ctx, name, cli, desktop, key, baseURL, models)
}

// existingAgentRouting is where an agent routes in the current mode, found
// without onboarding: a switch rewrites configs and never opens a model
// picker or creates a router. An agent with no hosted router yet is named
// with how to set it up.
func existingAgentRouting(ctx context.Context, name string, stdin io.Reader, stderr io.Writer) (string, string, agents.Models, error) {
	gw, err := currentGateway()
	if err != nil {
		return "", "", agents.Models{}, err
	}
	if gw != nil {
		if err := gw.ensure(ctx, stderr); err != nil {
			return "", "", agents.Models{}, err
		}
		models, err := routerModels(ctx, gw.url, gw.key, name)
		return gw.key, gw.url, models, err
	}
	access, err := resolveAgentRoutingAccess(ctx, stdin, stderr)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	client, err := auth.OrgKeyClient(access.apiURL)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	routers, err := listAgentRouters(ctx, client)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	setup := agentSetups[name]
	router, ok := setup.assignedAgentRouter(routers)
	if !ok && setup.ownsRouter() {
		// Launch decides between the agent's own routers the same way: its own
		// provider's subscription connected uses the subscription router even
		// over an earlier opt-out; otherwise an opt-out keeps the managed one.
		optedOut, err := agentSubscriptionOptedOut(ctx, client, name)
		if err != nil {
			return "", "", agents.Models{}, err
		}
		subscribed, err := connectedAgentSubscriptions(ctx, client, setup.subscriptions)
		if err != nil {
			return "", "", agents.Models{}, err
		}
		ownConnected := slices.Contains(subscribed, setup.subscriptions[0])
		clientKey, _ := setup.ownRouter(ownConnected || (!optedOut && len(subscribed) > 0))
		router, ok = findAgentRouter(routers, func(router agentRouter) bool { return router.ClientKey == clientKey })
	}
	if !ok && !setup.ownsRouter() {
		router, ok = findAgentRouter(routers, func(router agentRouter) bool { return router.IsDefault })
	}
	if !ok || len(router.EnabledModels) == 0 {
		return "", "", agents.Models{}, errors.New("it has no hosted router yet")
	}
	baseURL := agentRoutingBaseURL(router.ID)
	models, err := routerModels(ctx, baseURL, access.key, "")
	return access.key, baseURL, models, err
}
