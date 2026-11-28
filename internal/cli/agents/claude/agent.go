package claude

import (
	"context"
	"path/filepath"
	"strconv"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// Agent is Claude Code, and the Claude app set up apart from it.
var Agent = agents.Agent{
	Name:          "claude",
	Label:         "Claude Code",
	Help:          "Launch Claude Code through Dari; forward all following arguments (`dari setup claude` for setup)",
	CodingAgent:   "claude_code",
	Suggestion:    "claude",
	Subscriptions: []string{"anthropic_claude_code", "openai_codex"},
	RouterKey:     "dari-cli:claude-code",
	SessionEnv:    "CLAUDE_CODE_SESSION_ID",
	// A launch whose settings are in a temporary file waits for Claude Code
	// to exit, to remove it.
	HandlesInterrupt: true,
	Configure:        Configure,
	// Claude Code keeps the user's pick even while the router cannot serve it.
	StartModel: StartModel,
	Warnings:   Warnings,
	SavedModel: func() string {
		settings, err := SettingsPath()
		if err != nil {
			return ""
		}
		return SavedModel(settings)
	},
	Setup: &agents.Setup{
		Applies:        "new Claude Code sessions pick it up",
		Desktop:        "the Claude app",
		DesktopApplies: "restart the Claude app to apply it there",
		IsSetUp: func(context.Context) (bool, bool) {
			return CLISetUp(), AppSetUp()
		},
		Save: func(_ context.Context, key, baseURL string, models agents.Models) error {
			settings, err := SettingsPath()
			if err != nil {
				return err
			}
			// Without Claude Code on PATH there is no login to keep.
			executable, _ := agents.Executable("claude")
			return CLISetup(settings, executable, baseURL, key, models)
		},
		SaveDesktop: func(key, baseURL string, models agents.Models) error {
			dir, err := DesktopDir()
			if err != nil {
				return err
			}
			settings, err := SettingsPath()
			if err != nil {
				return err
			}
			return Setup(dir, settings, baseURL, key, models)
		},
		Remove: func(context.Context) (bool, error) {
			dir, err := DesktopDir()
			if err != nil {
				return false, err
			}
			settings, err := SettingsPath()
			if err != nil {
				return false, err
			}
			// Claude Code first, then the app: the app's setup also sets the
			// hint-header variable, which Claude Code's setup may have recorded as
			// already set, and the app's removal clears it.
			cli, err := RemoveCLISetup(settings)
			if err != nil {
				return false, err
			}
			app, err := RemoveSetup(dir, settings)
			return app || cli, err
		},
	},
	Local: local,
	Traces: &agents.Traces{
		Path: func() (string, error) {
			settings, err := SettingsPath()
			return filepath.Join(filepath.Dir(settings), "projects"), err
		},
		Sessions: agents.TranscriptFiles(parseClaudeTranscript, "*.jsonl"),
	},
}

// CLISetUp reports whether Claude Code has Dari set up.
func CLISetUp() bool {
	settings, err := SettingsPath()
	return err == nil && IsCLISetUp(settings)
}

// AppSetUp reports whether the Claude app has Dari set up.
func AppSetUp() bool {
	dir, err := DesktopDir()
	return err == nil && IsSetUp(dir)
}

// local runs Claude Code on the local model through the bridge, which speaks
// the Messages API.
func local(_ context.Context, command agents.Command, local agents.Local) (agents.Command, error) {
	url, key, err := local.Bridge()
	if err != nil {
		return command, err
	}
	id := agents.Models{Enabled: []string{"local/" + local.Model}, ContextWindow: local.Window}.Default()
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--model", id})
	env := map[string]string{
		"ANTHROPIC_BASE_URL":                       url,
		"ANTHROPIC_AUTH_TOKEN":                     key,
		"ANTHROPIC_API_KEY":                        "",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
		"CLAUDE_CODE_MAX_CONTEXT_TOKENS":           strconv.Itoa(local.Window),
		"CLAUDE_CODE_MAX_OUTPUT_TOKENS":            strconv.Itoa(local.Output),
		"ANTHROPIC_CUSTOM_HEADERS":                 "",
		"CLAUDE_CODE_AUTO_MODE_MODEL":              id,
		"CLAUDE_CODE_SUBAGENT_MODEL":               id,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":            id,
		"ANTHROPIC_DEFAULT_SONNET_MODEL":           id,
		"ANTHROPIC_DEFAULT_FABLE_MODEL":            id,
		"ANTHROPIC_DEFAULT_OPUS_MODEL":             id,
		"CLAUDE_CODE_USE_BEDROCK":                  "0",
		"CLAUDE_CODE_USE_VERTEX":                   "0",
		"CLAUDE_CODE_USE_FOUNDRY":                  "0",
	}
	// Saved Claude settings override inherited env. A launch-scoped
	// settings file keeps the chosen endpoint and credentials together.
	settings, err := local.Config("claude.json", map[string]any{"env": env, "modelPicker": map[string]any{"options": []any{map[string]string{"model": id, "label": local.Model}}, "replaceBuiltInOptions": true}})
	if err != nil {
		return command, err
	}
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--settings", settings})
	command.Env = agents.WithEnvironment(command.Env, env)
	return command, nil
}
