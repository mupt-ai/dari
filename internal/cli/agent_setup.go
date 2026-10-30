package cli

import (
	"context"
	"fmt"
	"io"

	"github.com/mupt-ai/dari-cli/internal/cli/agents/claude"
	"github.com/mupt-ai/dari-cli/internal/cli/agents/codex"
)

var agentAppNames = map[string]string{"claude": "Claude", "codex": "Codex"}

// runAgentSetup writes, or with --remove-setup removes, the persistent config
// the agent's desktop app reads. Setup runs the launcher's onboarding first,
// so the app uses the same router, key, and model menu as `dari <agent>`.
func runAgentSetup(ctx context.Context, launch agentLaunch, stdin io.Reader, stderr io.Writer) error {
	app, ok := agentAppNames[launch.name]
	if !ok {
		return fmt.Errorf("%s and %s are only available for claude and codex", agentSetupFlag, agentRemoveSetupFlag)
	}
	if launch.setup && launch.removeSetup {
		return fmt.Errorf("use either %s or %s", agentSetupFlag, agentRemoveSetupFlag)
	}
	if len(launch.args) > 0 {
		return fmt.Errorf("%s does not take agent arguments", agentSetupFlag)
	}
	if launch.removeSetup {
		removed, err := removeAgentSetup(launch.name)
		if err != nil {
			return err
		}
		if !removed {
			agentStep(stderr, "Dari is not set up in the "+app+" app")
			return nil
		}
		agentStep(stderr, "Removed Dari from the "+app+" app; restart it to apply")
		return nil
	}
	key, baseURL, models, err := resolveAgentRouting(ctx, launch, stdin, stderr)
	if err != nil {
		return err
	}
	switch launch.name {
	case "claude":
		dir, err := claude.DesktopDir()
		if err != nil {
			return err
		}
		settings, err := claude.SettingsPath()
		if err != nil {
			return err
		}
		if err := claude.Setup(dir, settings, baseURL, key, models); err != nil {
			return err
		}
	case "codex":
		home, err := codex.Home()
		if err != nil {
			return err
		}
		catalog, disableWebSearch, err := codex.Catalog(ctx, key, baseURL, models)
		if err != nil {
			return err
		}
		if err := codex.Setup(home, baseURL, key, models.Default(), catalog, disableWebSearch); err != nil {
			return err
		}
	}
	agentStep(stderr, fmt.Sprintf("The %s app now routes through Dari, starting on %s; restart it to apply", app, models.Default()))
	agentStep(stderr, fmt.Sprintf("Run `dari %s %s` again after changing the router's models, or `dari %s %s` to undo", launch.name, agentSetupFlag, launch.name, agentRemoveSetupFlag))
	return nil
}

func removeAgentSetup(name string) (bool, error) {
	if name == "claude" {
		dir, err := claude.DesktopDir()
		if err != nil {
			return false, err
		}
		settings, err := claude.SettingsPath()
		if err != nil {
			return false, err
		}
		return claude.RemoveSetup(dir, settings)
	}
	home, err := codex.Home()
	if err != nil {
		return false, err
	}
	return codex.RemoveSetup(home)
}
