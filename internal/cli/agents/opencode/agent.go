package opencode

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// Agent is OpenCode.
var Agent = agents.Agent{
	Name:             "opencode",
	Label:            "OpenCode",
	Help:             "Launch OpenCode through Dari; forward all following arguments (`dari setup opencode` for setup)",
	CodingAgent:      "opencode",
	Suggestion:       "default",
	Subscriptions:    []string{"openai_codex"},
	HandlesInterrupt: true,
	Configure: func(command *agents.Command, _, baseURL string, models agents.Models, _ bool) error {
		return Configure(command, baseURL, models)
	},
	SavedModel: func() string {
		dir, err := StateDir()
		if err != nil {
			return ""
		}
		return SavedModel(dir)
	},
	Setup: &agents.Setup{
		Applies: "new OpenCode sessions pick it up",
		IsSetUp: func(context.Context) (bool, bool) {
			dir, err := ConfigDir()
			return err == nil && IsSetUp(dir), false
		},
		Save: func(_ context.Context, key, baseURL string, models agents.Models) error {
			dir, err := ConfigDir()
			if err != nil {
				return err
			}
			return Setup(dir, baseURL, key, models)
		},
		Remove: func(context.Context) (bool, error) {
			dir, err := ConfigDir()
			if err != nil {
				return false, err
			}
			return RemoveSetup(dir)
		},
	},
	Local: local,
	Traces: &agents.Traces{
		Path: func() (string, error) {
			data := os.Getenv("XDG_DATA_HOME")
			if data == "" {
				home, err := os.UserHomeDir()
				if err != nil {
					return "", fmt.Errorf("find home directory: %w", err)
				}
				data = filepath.Join(home, ".local", "share")
			}
			return filepath.Join(data, "opencode", "opencode.db"), nil
		},
		Sessions: openCodeSessions,
	},
}

// local runs OpenCode on the local model's own API, with a config of its own.
func local(_ context.Context, command agents.Command, local agents.Local) (agents.Command, error) {
	ref := "dari-local/" + local.Model
	entry := map[string]any{"name": local.Model, "limit": map[string]int{"context": local.Window, "output": local.Output}}
	provider := map[string]any{
		"npm":     "@ai-sdk/openai-compatible",
		"options": map[string]string{"baseURL": local.Endpoint, "apiKey": "local"},
		"models":  map[string]any{local.Model: entry},
	}
	cfg := map[string]any{
		"model": ref, "small_model": ref, "enabled_providers": []string{"dari-local"},
		"provider": map[string]any{"dari-local": provider},
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		return command, err
	}
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--standalone"})
	command.Env = agents.WithEnvironment(command.Env, map[string]string{"OPENCODE_CONFIG_CONTENT": string(b), "OPENCODE_DISABLE_AUTOUPDATE": "1"})
	return command, nil
}
