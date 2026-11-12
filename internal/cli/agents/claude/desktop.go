package claude

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// The Claude app's third-party inference mode reads gateway configurations
// from Claude-3p/configLibrary: one JSON file per entry, plus _meta.json naming
// the applied entry. Setup owns one entry with a fixed id.
const (
	desktopEntryID   = "da71da71-0000-4000-8000-000000000001"
	desktopEntryName = "Dari"
	// The app starts Claude Code without the launcher's environment, so the
	// request-class headers that give subagents their own routing come from
	// the user's Claude Code settings instead.
	hintHeadersEnv = "CLAUDE_CODE_GATEWAY_HINT_HEADERS"
	// desktopRoutingModel is the model id the app sends for routing. The app
	// drops ids that do not name a Claude model, and the router treats every
	// Claude model id as dari/routing.
	desktopRoutingModel = "claude-dari-routing"
)

// DesktopDir is the Claude app's third-party configuration directory.
func DesktopDir() (string, error) {
	if runtime.GOOS == "windows" {
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			return filepath.Join(local, "Claude-3p"), nil
		}
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find Claude app configuration: %w", err)
	}
	return filepath.Join(dir, "Claude-3p"), nil
}

// SettingsPath is Claude Code's user settings file.
func SettingsPath() (string, error) {
	if dir := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); dir != "" {
		return filepath.Join(dir, "settings.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home directory: %w", err)
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

// Setup applies a Dari gateway entry in the Claude app at dir, offering the
// router's models, and turns on request-class headers in settingsPath.
func Setup(dir, settingsPath, baseURL, key string, models agents.Models) error {
	menu := desktopModels(models)
	if len(menu) == 0 {
		return fmt.Errorf("the Claude app only lists Claude models; enable one on the router or get Autorouting with `dari accounts`")
	}
	library := filepath.Join(dir, "configLibrary")
	if err := os.MkdirAll(library, 0o700); err != nil {
		return fmt.Errorf("create Claude app configuration: %w", err)
	}
	entry := map[string]any{
		"inferenceProvider":       "gateway",
		"inferenceGatewayBaseUrl": baseURL,
		"inferenceCredentialKind": "static",
		"inferenceGatewayApiKey":  key,
		"inferenceModels":         menu,
		"modelDiscoveryEnabled":   false,
	}
	if err := writeJSON(filepath.Join(library, desktopEntryID+".json"), entry); err != nil {
		return err
	}
	meta, err := readJSON(filepath.Join(library, "_meta.json"))
	if err != nil {
		return err
	}
	entries := metaEntries(meta)
	if !hasDesktopEntry(entries) {
		entries = append(entries, map[string]any{"id": desktopEntryID, "name": desktopEntryName})
	}
	meta["entries"] = entries
	meta["appliedId"] = desktopEntryID
	if err := writeJSON(filepath.Join(library, "_meta.json"), meta); err != nil {
		return err
	}
	return updateSettings(settingsPath, func(env map[string]any) { env[hintHeadersEnv] = "1" })
}

// RemoveSetup removes the Dari entry, applying another entry if one remains,
// and reports whether there was anything to remove.
func RemoveSetup(dir, settingsPath string) (bool, error) {
	library := filepath.Join(dir, "configLibrary")
	err := os.Remove(filepath.Join(library, desktopEntryID+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("remove Claude app configuration: %w", err)
	}
	metaPath := filepath.Join(library, "_meta.json")
	meta, err := readJSON(metaPath)
	if err != nil {
		return false, err
	}
	var entries []any
	for _, entry := range metaEntries(meta) {
		if fields, ok := entry.(map[string]any); !ok || fields["id"] != desktopEntryID {
			entries = append(entries, entry)
		}
	}
	if len(entries) == 0 {
		if err := os.Remove(metaPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, fmt.Errorf("remove Claude app configuration: %w", err)
		}
	} else {
		meta["entries"] = entries
		if meta["appliedId"] == desktopEntryID {
			meta["appliedId"] = entries[0].(map[string]any)["id"]
		}
		if err := writeJSON(metaPath, meta); err != nil {
			return false, err
		}
	}
	return true, updateSettings(settingsPath, func(env map[string]any) { delete(env, hintHeadersEnv) })
}

// desktopModels is the launcher's menu as the Claude app accepts it. The app
// drops model ids that do not name a Claude model, so routing is offered under
// a Claude id of its own and explicit models from other families are left out.
//
// The app starts Claude Code with the opus alias pinned to the entry in the
// opus tier or, when no entry is, to the first Opus on the list, and has Claude
// Code ignore the pins in its own settings. Routing takes the tier, so opus,
// which subagents and auto mode ask for, routes instead of naming an explicit
// model.
func desktopModels(models agents.Models) []map[string]string {
	var menu []map[string]string
	for _, model := range models.Menu() {
		if model == agents.RoutingModel {
			menu = append(menu, map[string]string{
				"name":                desktopRoutingModel,
				"labelOverride":       "Dari Routing",
				"anthropicFamilyTier": "opus",
			})
			continue
		}
		id := strings.TrimPrefix(model, agents.ExplicitModelPrefix)
		if strings.Contains(strings.ToLower(id), "claude") {
			menu = append(menu, map[string]string{"name": model, "labelOverride": id})
		}
	}
	return menu
}

func metaEntries(meta map[string]any) []any {
	entries, _ := meta["entries"].([]any)
	return entries
}

func hasDesktopEntry(entries []any) bool {
	for _, entry := range entries {
		if fields, ok := entry.(map[string]any); ok && fields["id"] == desktopEntryID {
			return true
		}
	}
	return false
}

func updateSettings(path string, update func(env map[string]any)) error {
	settings, err := readJSON(path)
	if err != nil {
		return err
	}
	env, _ := settings["env"].(map[string]any)
	if env == nil {
		env = map[string]any{}
	}
	update(env)
	if len(env) == 0 {
		delete(settings, "env")
	} else {
		settings["env"] = env
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create Claude Code settings directory: %w", err)
	}
	return writeJSON(path, settings)
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
		_ = os.Remove(temp)
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// IsSetUp reports whether Dari is set up in the Claude app.
func IsSetUp(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "configLibrary", desktopEntryID+".json"))
	return err == nil
}
