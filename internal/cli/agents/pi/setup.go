package pi

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

// Setup files in Pi's agent directory: the Dari provider extension, which Pi
// loads on its own from extensions/; dari.json, where it reads the router,
// key, and models when Pi is run directly; and dari-setup.json, which records
// the settings setup replaced so RemoveSetup restores them.
const (
	extensionFile = "dari.ts"
	configFile    = "dari.json"
	setupFile     = "dari-setup.json"
)

// The settings setup writes. enabledModels scopes /model to the router's
// models, as a launch's --models does.
var setupKeys = []string{"defaultProvider", "defaultModel", "enabledModels"}

// AgentDir is Pi's agent directory: PI_CODING_AGENT_DIR, or ~/.pi/agent.
func AgentDir() (string, error) {
	if dir := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_DIR")); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home directory: %w", err)
	}
	return filepath.Join(home, ".pi", "agent"), nil
}

// SavedModel is the Dari model Pi saved as its default, which its /model
// sets, or "" when its default is another provider's.
func SavedModel(dir string) string {
	settings, err := readJSON(filepath.Join(dir, "settings.json"))
	if err != nil || settings["defaultProvider"] != "dari" {
		return ""
	}
	model, _ := settings["defaultModel"].(string)
	return model
}

// Setup makes Dari Pi's default provider, so `pi` itself routes through Dari
// as `dari pi` does: it installs the provider extension, saves the router,
// key, and models for it, and sets Pi's default model (the launch's, which
// keeps the user's last /model pick) and model scope. It runs on every
// launch; each setting it replaces is recorded the first time. It reports
// whether this was the first setup.
func Setup(dir, baseURL, key string, models agents.Models) (bool, error) {
	executable, err := agents.StatusExecutable()
	if err != nil {
		return false, err
	}
	settingsPath := filepath.Join(dir, "settings.json")
	settings, err := readJSON(settingsPath)
	if err != nil {
		return false, err
	}
	setupPath := filepath.Join(dir, setupFile)
	replaced, err := readJSON(setupPath)
	if err != nil {
		return false, err
	}
	first := len(replaced) == 0
	values := map[string]any{
		"defaultProvider": "dari",
		"defaultModel":    models.Default(),
		"enabledModels":   scopedModels(models),
	}
	for _, key := range setupKeys {
		if _, ok := replaced[key]; !ok {
			if value, present := settings[key]; present {
				replaced[key] = map[string]any{"value": value}
			} else {
				replaced[key] = map[string]any{}
			}
		}
		settings[key] = values[key]
	}
	if err := os.MkdirAll(filepath.Join(dir, "extensions"), 0o700); err != nil {
		return false, fmt.Errorf("create Pi extensions directory: %w", err)
	}
	// The record first: files written without it could not be undone.
	if err := writeJSON(setupPath, replaced); err != nil {
		return false, err
	}
	if err := os.WriteFile(filepath.Join(dir, "extensions", extensionFile), []byte(extension), 0o600); err != nil {
		return false, fmt.Errorf("write Pi provider: %w", err)
	}
	if err := writeJSON(filepath.Join(dir, configFile), map[string]any{
		"baseUrl":          baseURL,
		"apiKey":           key,
		"models":           models.Menu(),
		"statusExecutable": executable,
	}); err != nil {
		return false, err
	}
	return first, writeJSON(settingsPath, settings)
}

// RemoveSetup restores the settings Setup replaced, removes its files, and
// reports whether Pi was set up.
func RemoveSetup(dir string) (bool, error) {
	setupPath := filepath.Join(dir, setupFile)
	replaced, err := readJSON(setupPath)
	if err != nil {
		return false, err
	}
	if len(replaced) == 0 {
		return false, nil
	}
	settingsPath := filepath.Join(dir, "settings.json")
	settings, err := readJSON(settingsPath)
	if err != nil {
		return false, err
	}
	for key, record := range replaced {
		fields, _ := record.(map[string]any)
		if value, ok := fields["value"]; ok {
			settings[key] = value
		} else {
			delete(settings, key)
		}
	}
	if err := writeJSON(settingsPath, settings); err != nil {
		return false, err
	}
	for _, path := range []string{filepath.Join(dir, "extensions", extensionFile), filepath.Join(dir, configFile), setupPath} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, fmt.Errorf("remove %s: %w", path, err)
		}
	}
	return true, nil
}

// scopedModels are the router's models as Pi names them: provider/model.
func scopedModels(models agents.Models) []string {
	scoped := make([]string, 0, len(models.Menu()))
	for _, model := range models.Menu() {
		scoped = append(scoped, "dari/"+model)
	}
	return scoped
}

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
		return nil, fmt.Errorf("%s is not a JSON object: %w", path, err)
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

// IsSetUp reports whether Dari is set up in dir.
func IsSetUp(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, setupFile))
	return err == nil
}
