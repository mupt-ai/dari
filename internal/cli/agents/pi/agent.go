package pi

import (
	"context"
	"path/filepath"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// Agent is Pi.
var Agent = agents.Agent{
	Name:          "pi",
	Label:         "Pi",
	Help:          "Launch Pi through Dari; forward all following arguments",
	CodingAgent:   "pi",
	Suggestion:    "default",
	Subscriptions: []string{"openai_codex"},
	Configure: func(command *agents.Command, _, baseURL string, models agents.Models, _ bool) error {
		return Configure(command, baseURL, models)
	},
	SavedModel: func() string {
		dir, err := AgentDir()
		if err != nil {
			return ""
		}
		return SavedModel(dir)
	},
	Setup: &agents.Setup{
		Applies: "new Pi sessions pick it up",
		IsSetUp: func(context.Context) (bool, bool) {
			dir, err := AgentDir()
			return err == nil && IsSetUp(dir), false
		},
		Save: func(_ context.Context, key, baseURL string, models agents.Models) error {
			dir, err := AgentDir()
			if err != nil {
				return err
			}
			return Setup(dir, baseURL, key, models)
		},
		Remove: func(context.Context) (bool, error) {
			dir, err := AgentDir()
			if err != nil {
				return false, err
			}
			return RemoveSetup(dir)
		},
	},
	Local: func(_ context.Context, command agents.Command, local agents.Local) (agents.Command, error) {
		return LocalCommand(command.Path, command.Args, local.Model, local.Endpoint, local.Window)
	},
	Traces: &agents.Traces{
		Path: func() (string, error) {
			dir, err := AgentDir()
			return filepath.Join(dir, "sessions"), err
		},
		Sessions: agents.TranscriptFiles(parsePiSession, "*.jsonl"),
	},
}
