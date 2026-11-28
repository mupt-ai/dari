package openclaw

import (
	"context"
	"os"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// Agent is OpenClaw. It routes on the setup in its own config, so a launch
// configures nothing.
var Agent = agents.Agent{
	Name:          "openclaw",
	Label:         "OpenClaw",
	Help:          "Launch OpenClaw, set up once with `dari setup openclaw --cli`; forward all following arguments",
	CodingAgent:   "openclaw",
	Suggestion:    "default",
	Subscriptions: []string{"openai_codex"},
	Setup: &agents.Setup{
		Applies: "its gateway picks it up without a restart",
		IsSetUp: func(ctx context.Context) (bool, bool) {
			executable, err := agents.Executable("openclaw")
			return err == nil && IsSetUp(ctx, executable), false
		},
		Save: func(ctx context.Context, key, baseURL string, models agents.Models) error {
			executable, err := agents.Executable("openclaw")
			if err != nil {
				return err
			}
			return Setup(ctx, executable, baseURL, key, models)
		},
		Remove: func(ctx context.Context) (bool, error) {
			executable, err := agents.Executable("openclaw")
			if err != nil {
				return false, err
			}
			return RemoveSetup(ctx, executable)
		},
	},
	Local: local,
}

// local runs OpenClaw on the local model's own API, with a config and state of
// the launch's own.
func local(_ context.Context, command agents.Command, local agents.Local) (agents.Command, error) {
	workspace, err := os.Getwd()
	if err != nil {
		return command, err
	}
	entry := map[string]any{"id": local.Model, "name": local.Model, "contextWindow": local.Window, "maxTokens": local.Output}
	provider := map[string]any{"api": "openai-completions", "baseUrl": local.Endpoint, "apiKey": "local", "models": []any{entry}}
	defaults := map[string]any{"workspace": workspace, "skipBootstrap": true, "model": map[string]string{"primary": "dari/" + local.Model}}
	cfg := map[string]any{
		"models": map[string]any{"providers": map[string]any{"dari": provider}},
		"agents": map[string]any{"defaults": defaults},
	}
	p, err := local.Config("openclaw.json", cfg)
	if err != nil {
		return command, err
	}
	sub := "tui"
	args := command.Args
	if len(args) > 0 && (args[0] == "agent" || args[0] == "tui") {
		sub, args = args[0], args[1:]
	}
	command.Args = append([]string{sub, "--local"}, args...)
	command.Env = agents.WithEnvironment(command.Env, map[string]string{"OPENCLAW_CONFIG_PATH": p, "OPENCLAW_STATE_DIR": local.Dir})
	return command, nil
}
