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

// agentApp is what --setup configures for an agent, and how the change
// takes effect.
type agentApp struct {
	name    string
	applies string
}

var agentApps = map[string]agentApp{
	"claude":   {name: "Claude Code and the Claude app", applies: "restart the app to apply"},
	"codex":    {name: "Codex and the Codex app", applies: "restart the app to apply"},
	"pi":       {name: "Pi", applies: "new Pi sessions pick it up"},
	"opencode": {name: "OpenCode", applies: "new OpenCode sessions pick it up"},
	"openclaw": {name: "OpenClaw", applies: "its gateway picks it up without a restart"},
	"hermes":   {name: "Hermes Agent", applies: "new sessions use it; run `hermes gateway restart` for messaging sessions already open"},
}

// launchSetsUpAgent marks agents whose sessions all run in one long-lived
// gateway that reads the agent's own config, so a launch cannot route only
// itself: every launch writes the same setup --setup does.
var launchSetsUpAgent = map[string]bool{"openclaw": true, "hermes": true}

// runAgentSetup writes, or with --remove-setup removes, the persistent config
// the agent's app or gateway reads. Setup runs the launcher's onboarding
// first, so it uses the same router, key, and model menu as `dari <agent>`.
func runAgentSetup(ctx context.Context, launch agentLaunch, stdin io.Reader, stderr io.Writer) error {
	app, ok := agentApps[launch.name]
	if !ok {
		names := make([]string, 0, len(agentApps))
		for name := range agentApps {
			names = append(names, name)
		}
		slices.Sort(names)
		return fmt.Errorf("%s and %s are only available for %s", agentSetupFlag, agentRemoveSetupFlag, strings.Join(names, ", "))
	}
	if launch.setup && launch.removeSetup {
		return fmt.Errorf("use either %s or %s", agentSetupFlag, agentRemoveSetupFlag)
	}
	if len(launch.args) > 0 {
		return fmt.Errorf("%s does not take agent arguments", agentSetupFlag)
	}
	if launch.removeSetup {
		removed, err := removeAgentSetup(ctx, launch.name)
		if err != nil {
			return err
		}
		if !removed {
			agentStep(stderr, "Dari is not set up in "+app.name)
			return nil
		}
		agentStep(stderr, "Removed Dari from "+app.name+"; "+app.applies)
		return nil
	}
	key, baseURL, models, err := resolveAgentRouting(ctx, launch, stdin, stderr)
	if err != nil {
		return err
	}
	// The app first: it is the step that can refuse (the Claude app lists
	// only Claude models), and nothing is written when it does.
	if err := applyAgentSetup(ctx, launch.name, key, baseURL, models); err != nil {
		return err
	}
	// Codex's app setup is its CLI setup.
	if launch.name != "codex" {
		if _, err := saveAgentConfig(ctx, launch.name, key, baseURL, models); err != nil {
			return err
		}
	}
	agentStep(stderr, fmt.Sprintf("%s now routes through Dari, starting on %s; %s", capitalized(app.name), models.Default(), app.applies))
	agentStep(stderr, fmt.Sprintf("Run `dari %s %s` again after changing the router's models, or `dari %s %s` to undo", launch.name, agentSetupFlag, launch.name, agentRemoveSetupFlag))
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

// saveAgentConfig writes Dari into the agent's own config on every launch, so
// the agent routes through Dari when run directly and keeps the user's model
// pick. It reports whether this was the agent's first setup.
func saveAgentConfig(ctx context.Context, name, key, baseURL string, models agents.Models) (bool, error) {
	switch name {
	case "claude":
		settings, err := claude.SettingsPath()
		if err != nil {
			return false, err
		}
		// Without Claude Code on PATH there is no login to keep.
		executable, _ := agentExecutable("claude")
		return claude.CLISetup(settings, executable, baseURL, key, models)
	case "codex":
		// Codex's app and CLI read the same config.toml, so its setup serves both.
		home, err := codex.Home()
		if err != nil {
			return false, err
		}
		first := !codex.IsSetUp(home)
		return first, applyAgentSetup(ctx, name, key, baseURL, models)
	case "pi":
		dir, err := pi.AgentDir()
		if err != nil {
			return false, err
		}
		return pi.Setup(dir, baseURL, key, models)
	case "opencode":
		dir, err := opencode.ConfigDir()
		if err != nil {
			return false, err
		}
		return opencode.Setup(dir, baseURL, key, models)
	}
	return false, nil
}

func applyAgentSetup(ctx context.Context, name, key, baseURL string, models agents.Models) error {
	switch name {
	case "claude":
		dir, err := claude.DesktopDir()
		if err != nil {
			return err
		}
		settings, err := claude.SettingsPath()
		if err != nil {
			return err
		}
		return claude.Setup(dir, settings, baseURL, key, models)
	case "codex":
		home, err := codex.Home()
		if err != nil {
			return err
		}
		catalog, disableWebSearch, err := codex.Catalog(ctx, key, baseURL, models)
		if err != nil {
			return err
		}
		return codex.Setup(home, baseURL, key, models.Default(), catalog, disableWebSearch, models.RemoteCompaction)
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
	case "pi", "opencode":
		// Neither has an app; saveAgentConfig is the whole setup.
		return nil
	}
	return fmt.Errorf("unsupported coding agent %q", name)
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
	if settings, err := claude.SettingsPath(); err == nil && claude.IsCLISetUp(settings) {
		set = append(set, "claude")
	} else if dir, err := claude.DesktopDir(); err == nil && claude.IsSetUp(dir) {
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
	if executable, err := agentExecutable("openclaw"); err == nil && openclaw.IsSetUp(ctx, executable) {
		set = append(set, "openclaw")
	}
	if config, err := hermesConfigPath(ctx); err == nil && hermes.IsSetUp(config) {
		set = append(set, "hermes")
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
		agentStep(stderr, "Set-up agents move to hosted Dari on their next `dari <agent>` launch, after you sign in")
		return
	}
	for _, name := range agentNames {
		if err := moveAgentSetup(ctx, name, stdin, stderr); err != nil {
			agentPrintln(stderr, fmt.Sprintf("%s still routes the old way (%v); run `dari %s %s`", agentApps[name].name, err, name, agentSetupFlag))
			continue
		}
		agentStep(stderr, capitalized(agentApps[name].name)+" moved; "+agentApps[name].applies)
	}
}

func moveAgentSetup(ctx context.Context, name string, stdin io.Reader, stderr io.Writer) error {
	key, baseURL, models, err := existingAgentRouting(ctx, name, stdin, stderr)
	if err != nil {
		return err
	}
	// Keep the user's last model pick, as a launch does.
	models.Saved = savedAgentModel(name)
	// The app first: it is the step that can refuse (the Claude app lists only
	// Claude models), and nothing moves when it does.
	claudeApp := false
	if name == "claude" {
		if dir, err := claude.DesktopDir(); err == nil && claude.IsSetUp(dir) {
			claudeApp = true
		}
	}
	if claudeApp || name == "openclaw" || name == "hermes" {
		if err := applyAgentSetup(ctx, name, key, baseURL, models); err != nil {
			return err
		}
	}
	// Codex's setup is its config; the others write their own settings.
	_, err = saveAgentConfig(ctx, name, key, baseURL, models)
	return err
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
