package claude

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// cliSetupFile, beside Claude Code's settings, records what setup replaced
// there so RemoveCLISetup restores it, and marks Claude Code as set up.
const cliSetupFile = "dari-setup.json"

// The top-level settings setup writes, besides `env`.
const (
	modelKey       = "model"
	modelPickerKey = "modelPicker"
	statusLineKey  = "statusLine"
)

// SavedModel is the model Claude Code saved as the user's default, which its
// /model sets, or "" when there is none.
func SavedModel(settingsPath string) string {
	settings, err := readJSON(settingsPath)
	if err != nil {
		return ""
	}
	model, _ := settings[modelKey].(string)
	return model
}

// CLISetup writes Dari into Claude Code's user settings so `claude` itself
// routes through Dari as `dari claude` does: the router and key, the model to
// start on (the launch's default, which keeps the user's last /model pick),
// the router's models in /model, and Dari's status line unless the user has
// their own. It runs on every launch, so the settings follow the routing
// mode. Each value it replaces is recorded the first time; it reports
// whether this was the first setup.
func CLISetup(settingsPath, baseURL, key string, models agents.Models) (bool, error) {
	settings, err := readJSON(settingsPath)
	if err != nil {
		return false, err
	}
	setupPath := filepath.Join(filepath.Dir(settingsPath), cliSetupFile)
	setup, err := readJSON(setupPath)
	if err != nil {
		return false, err
	}
	first := len(setup) == 0
	replaced := recorded(setup, "settings")
	replacedEnv := recorded(setup, "env")

	set := func(key string, value any) {
		if _, ok := replaced[key]; !ok {
			replaced[key] = previous(settings, key)
		}
		settings[key] = value
	}
	set(modelKey, models.Default())
	set(modelPickerKey, map[string]any{"options": pickerOptions(models), "replaceBuiltInOptions": true})
	// A status line the user set before Dari is theirs to keep.
	if _, owned := replaced[statusLineKey]; owned || settings[statusLineKey] == nil {
		executable, err := agents.StatusExecutable()
		if err != nil {
			return false, err
		}
		set(statusLineKey, map[string]any{
			"type":    "command",
			"command": agents.ShellQuote(executable) + " agent-status --claude",
		})
	}

	env, _ := settings["env"].(map[string]any)
	if env == nil {
		env = map[string]any{}
	}
	for name, value := range routingEnvironment(key, baseURL, models) {
		if _, ok := replacedEnv[name]; !ok {
			replacedEnv[name] = previous(env, name)
		}
		env[name] = value
	}
	settings["env"] = env

	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o700); err != nil {
		return false, fmt.Errorf("create Claude Code settings directory: %w", err)
	}
	// The record first: settings written without it could not be undone.
	if err := writeJSON(setupPath, map[string]any{"settings": replaced, "env": replacedEnv}); err != nil {
		return false, err
	}
	return first, writeJSON(settingsPath, settings)
}

// RemoveCLISetup restores what CLISetup replaced in Claude Code's settings and
// reports whether Claude Code was set up.
func RemoveCLISetup(settingsPath string) (bool, error) {
	setupPath := filepath.Join(filepath.Dir(settingsPath), cliSetupFile)
	setup, err := readJSON(setupPath)
	if err != nil {
		return false, err
	}
	if len(setup) == 0 {
		return false, nil
	}
	settings, err := readJSON(settingsPath)
	if err != nil {
		return false, err
	}
	restore(settings, recorded(setup, "settings"))
	// A Dari model saved before setup (by /model in a `dari claude` session)
	// would send plain `claude` to a model Anthropic does not have.
	if model, _ := settings[modelKey].(string); strings.HasPrefix(model, "dari/") {
		delete(settings, modelKey)
	}
	env, _ := settings["env"].(map[string]any)
	if env == nil {
		env = map[string]any{}
	}
	restore(env, recorded(setup, "env"))
	if len(env) == 0 {
		delete(settings, "env")
	} else {
		settings["env"] = env
	}
	if err := writeJSON(settingsPath, settings); err != nil {
		return false, err
	}
	if err := os.Remove(setupPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("remove %s: %w", setupPath, err)
	}
	return true, nil
}

// previous records a value setup replaces: {"value": v}, or {} when absent.
func previous(values map[string]any, key string) map[string]any {
	if value, ok := values[key]; ok {
		return map[string]any{"value": value}
	}
	return map[string]any{}
}

// recorded is one section of the setup record, created when missing.
func recorded(setup map[string]any, section string) map[string]any {
	values, _ := setup[section].(map[string]any)
	if values == nil {
		values = map[string]any{}
	}
	return values
}

func restore(values map[string]any, replaced map[string]any) {
	for key, record := range replaced {
		fields, _ := record.(map[string]any)
		if value, ok := fields["value"]; ok {
			values[key] = value
		} else {
			delete(values, key)
		}
	}
}
