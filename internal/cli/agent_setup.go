package cli

import (
	"context"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/mupt-ai/dari-cli/internal/cli/agents"
	"github.com/mupt-ai/dari-cli/internal/cli/agents/claude"
	"github.com/mupt-ai/dari-cli/internal/cli/agents/codex"
	"github.com/mupt-ai/dari-cli/internal/cli/agents/hermes"
	"github.com/mupt-ai/dari-cli/internal/cli/agents/openclaw"
)

// agentApp is what --setup configures for an agent, and how the change
// takes effect.
type agentApp struct {
	name    string
	applies string
}

var agentApps = map[string]agentApp{
	"claude":   {name: "the Claude app", applies: "restart it to apply"},
	"codex":    {name: "the Codex app", applies: "restart it to apply"},
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
	if err := applyAgentSetup(ctx, launch.name, key, baseURL, models); err != nil {
		return err
	}
	agentStep(stderr, fmt.Sprintf("%s now routes through Dari, starting on %s; %s", capitalized(app.name), models.Default(), app.applies))
	agentStep(stderr, fmt.Sprintf("Run `dari %s %s` again after changing the router's models, or `dari %s %s` to undo", launch.name, agentSetupFlag, launch.name, agentRemoveSetupFlag))
	return nil
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
		return codex.Setup(home, baseURL, key, models.Default(), catalog, disableWebSearch)
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
		return claude.RemoveSetup(dir, settings)
	case "codex":
		home, err := codex.Home()
		if err != nil {
			return false, err
		}
		return codex.RemoveSetup(home)
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
