package opencode

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// setupFile, beside OpenCode's config, records the settings setup replaced so
// RemoveSetup restores them, and marks OpenCode as set up.
const setupFile = "dari-setup.json"

// ConfigDir is OpenCode's global config directory: $XDG_CONFIG_HOME/opencode,
// or ~/.config/opencode.
func ConfigDir() (string, error) {
	return xdgDir("XDG_CONFIG_HOME", ".config")
}

// StateDir is where OpenCode keeps state such as its recent models:
// $XDG_STATE_HOME/opencode, or ~/.local/state/opencode.
func StateDir() (string, error) {
	return xdgDir("XDG_STATE_HOME", filepath.Join(".local", "state"))
}

func xdgDir(variable, fallback string) (string, error) {
	if dir := strings.TrimSpace(os.Getenv(variable)); dir != "" {
		return filepath.Join(dir, "opencode"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home directory: %w", err)
	}
	return filepath.Join(home, fallback, "opencode"), nil
}

// SavedModel is the Dari model OpenCode used most recently, from the recent
// models it keeps in stateDir, or "" when it has none.
func SavedModel(stateDir string) string {
	var state struct {
		Recent []struct {
			ProviderID string `json:"providerID"`
			ModelID    string `json:"modelID"`
		} `json:"recent"`
	}
	body, err := os.ReadFile(filepath.Join(stateDir, "model.json"))
	if err != nil || json.Unmarshal(body, &state) != nil {
		return ""
	}
	for _, recent := range state.Recent {
		// Dari's models are keyed under the provider without its "dari/".
		if recent.ProviderID == "dari" && recent.ModelID != "" {
			return "dari/" + recent.ModelID
		}
	}
	return ""
}

// Settings setup sets outright, recording the user's value to restore.
var replacedSettings = []string{"model", "small_model", "enabled_providers"}

// Setup writes Dari into OpenCode's opencode.json so `opencode` itself
// routes through Dari as `dari opencode` does: the router as the only enabled
// provider, with its key and models, the status plugin, and the model to
// start on. It adds to the user's providers, plugins, and agents rather than
// replacing them. It runs on every launch; each setting it replaces is
// recorded the first time. It reports whether this was the first setup.
//
// Once the user has picked a Dari model in OpenCode (models.Saved), setup
// sets no `model`: OpenCode's config `model` outranks its own recent models,
// so leaving it out lets the user's latest pick win when run directly.
func Setup(configDir, baseURL, key string, models agents.Models) (bool, error) {
	pluginDirectory, err := writeOpenCodeStatusPlugin()
	if err != nil {
		return false, err
	}
	executable, err := agents.StatusExecutable()
	if err != nil {
		return false, err
	}
	// `opencode` run directly has no launcher environment to name it.
	if err := os.WriteFile(filepath.Join(filepath.Dir(pluginDirectory), "status-executable"), []byte(executable), 0o600); err != nil {
		return false, fmt.Errorf("write OpenCode status: %w", err)
	}

	configPath := filepath.Join(configDir, "opencode.json")
	config, err := readJSON(configPath)
	if err != nil {
		return false, err
	}
	setupPath := filepath.Join(configDir, setupFile)
	record, err := readJSON(setupPath)
	if err != nil {
		return false, err
	}
	first := len(record) == 0
	replaced := section(record, "settings")
	agentModels := section(record, "agent_models")
	settings := openCodeSettings(baseURL, pluginDirectory, key, models)

	for _, name := range replacedSettings {
		if _, ok := replaced[name]; !ok {
			replaced[name] = previous(config, name)
		}
		// No model at all, not the user's pre-Dari one: any config model
		// outranks the recent Dari pick. The record keeps it for removal.
		if name == "model" && models.Saved != "" && models.Default() == models.Saved {
			delete(config, name)
			continue
		}
		config[name] = settings[name]
	}

	providers := object(config, "provider")
	providers["dari"] = settings["provider"].(map[string]any)["dari"]

	plugins, _ := config["plugins"].([]any)
	if !containsString(plugins, pluginDirectory) {
		config["plugins"] = append(plugins, pluginDirectory)
	}

	// Only each agent's model is set; its other settings stay the user's.
	agentsConfig := object(config, "agent")
	for name, pin := range settings["agent"].(map[string]any) {
		agentConfig := object(agentsConfig, name)
		if _, ok := agentModels[name]; !ok {
			agentModels[name] = previous(agentConfig, "model")
		}
		agentConfig["model"] = pin.(map[string]string)["model"]
	}

	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return false, fmt.Errorf("create OpenCode config directory: %w", err)
	}
	// The record first: config written without it could not be undone.
	if err := writeJSON(setupPath, map[string]any{"settings": replaced, "agent_models": agentModels, "plugin": pluginDirectory}); err != nil {
		return false, err
	}
	return first, writeJSON(configPath, config)
}

// RemoveSetup takes Dari back out of opencode.json, restoring what Setup
// replaced and keeping providers, plugins, and agents the user added since,
// and reports whether OpenCode was set up.
func RemoveSetup(configDir string) (bool, error) {
	setupPath := filepath.Join(configDir, setupFile)
	record, err := readJSON(setupPath)
	if err != nil {
		return false, err
	}
	if len(record) == 0 {
		return false, nil
	}
	configPath := filepath.Join(configDir, "opencode.json")
	config, err := readJSON(configPath)
	if err != nil {
		return false, err
	}
	for name, recorded := range section(record, "settings") {
		restore(config, name, recorded)
	}
	if providers, ok := config["provider"].(map[string]any); ok {
		delete(providers, "dari")
		dropIfEmpty(config, "provider")
	}
	if plugins, ok := config["plugins"].([]any); ok {
		plugin, _ := record["plugin"].(string)
		kept := []any{}
		for _, entry := range plugins {
			if entry != plugin {
				kept = append(kept, entry)
			}
		}
		config["plugins"] = kept
		dropIfEmpty(config, "plugins")
	}
	if agentsConfig, ok := config["agent"].(map[string]any); ok {
		for name, recorded := range section(record, "agent_models") {
			if agentConfig, ok := agentsConfig[name].(map[string]any); ok {
				restore(agentConfig, "model", recorded)
				dropIfEmpty(agentsConfig, name)
			}
		}
		dropIfEmpty(config, "agent")
	}
	if len(config) == 0 {
		err = os.Remove(configPath)
	} else {
		err = writeJSON(configPath, config)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
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

func restore(values map[string]any, key string, recorded any) {
	fields, _ := recorded.(map[string]any)
	if value, ok := fields["value"]; ok {
		values[key] = value
	} else {
		delete(values, key)
	}
}

// section is one part of the setup record, created when missing.
func section(record map[string]any, name string) map[string]any {
	values, _ := record[name].(map[string]any)
	if values == nil {
		values = map[string]any{}
	}
	return values
}

// object is values[key] as an object, created in place when missing.
func object(values map[string]any, key string) map[string]any {
	existing, _ := values[key].(map[string]any)
	if existing == nil {
		existing = map[string]any{}
		values[key] = existing
	}
	return existing
}

func dropIfEmpty(values map[string]any, key string) {
	switch value := values[key].(type) {
	case map[string]any:
		if len(value) == 0 {
			delete(values, key)
		}
	case []any:
		if len(value) == 0 {
			delete(values, key)
		}
	}
}

func containsString(values []any, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// readJSON reads a JSON object; a missing file is empty. opencode.json with
// comments or trailing commas is refused rather than rewritten without them.
func readJSON(path string) (map[string]any, error) {
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	value := map[string]any{}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("%s is not plain JSON, so Dari leaves it as it is: %w", path, err)
	}
	return value, nil
}

func writeJSON(path string, value map[string]any) error {
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	temp := path + ".dari-tmp"
	if err := os.WriteFile(temp, body.Bytes(), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Rename(temp, path); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}
