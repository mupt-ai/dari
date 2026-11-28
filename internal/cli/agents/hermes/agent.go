package hermes

import (
	"context"
	"fmt"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// localContextWindow is the least context Hermes runs with.
const localContextWindow = 64000

// Agent is Hermes Agent. It routes on the setup in its own config, so a launch
// configures nothing.
var Agent = agents.Agent{
	Name:          "hermes",
	Label:         "Hermes Agent",
	Help:          "Launch Hermes Agent, set up once with `dari setup hermes --cli`; forward all following arguments",
	CodingAgent:   "hermes",
	Suggestion:    "default",
	Subscriptions: []string{"openai_codex"},
	Setup: &agents.Setup{
		Applies: "new sessions use it; run `hermes gateway restart` for messaging sessions already open",
		IsSetUp: func(ctx context.Context) (bool, bool) {
			config, err := configPath(ctx)
			return err == nil && IsSetUp(config), false
		},
		Save: func(ctx context.Context, key, baseURL string, models agents.Models) error {
			config, err := configPath(ctx)
			if err != nil {
				return err
			}
			return Setup(config, baseURL, key, models)
		},
		Remove: func(ctx context.Context) (bool, error) {
			config, err := configPath(ctx)
			if err != nil {
				return false, err
			}
			return RemoveSetup(config)
		},
	},
	Local:              local,
	LocalContextWindow: localContextWindow,
}

func configPath(ctx context.Context) (string, error) {
	executable, err := agents.Executable("hermes")
	if err != nil {
		return "", err
	}
	return ConfigPath(ctx, executable)
}

// local runs Hermes on the local model's own API, with a home of the
// launch's own.
func local(_ context.Context, command agents.Command, local agents.Local) (agents.Command, error) {
	if local.Window < localContextWindow {
		return command, fmt.Errorf("Hermes needs at least %d context tokens; restart the engine with dari run %s --context-window %d", localContextWindow, local.Model, localContextWindow)
	}
	cfg := map[string]any{"model": map[string]any{"default": local.Model, "provider": "custom", "base_url": local.Endpoint, "context_length": local.Window}}
	if _, err := local.Config("config.yaml", cfg); err != nil {
		return command, err
	}
	args := command.Args
	if len(args) > 0 && args[0] == "chat" {
		args = args[1:]
	}
	command.Args = append([]string{"chat", "--provider", "custom", "--model", local.Model}, args...)
	command.Env = agents.WithEnvironment(command.Env, map[string]string{"HERMES_HOME": local.Dir, "CUSTOM_BASE_URL": local.Endpoint, "OPENAI_API_KEY": "local"})
	return command, nil
}
