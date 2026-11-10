package opencode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

func cacheHome(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
}

// Every launch writes Dari into opencode.json so `opencode` itself routes
// through Dari; the user's own settings come back on removal.
func TestSetupRoundTrip(t *testing.T) {
	cacheHome(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "opencode.json"), []byte(`{"model":"anthropic/claude-sonnet","theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models := agents.Models{Enabled: []string{"a/one", "a/two"}}
	first, err := Setup(dir, "https://routing.test", "dak_1", models)
	if err != nil || !first {
		t.Fatalf("first setup = %v, %v", first, err)
	}
	config, _ := readJSON(filepath.Join(dir, "opencode.json"))
	provider := config["provider"].(map[string]any)["dari"].(map[string]any)
	if config["model"] != "dari/model/a/one" || config["theme"] != "dark" {
		t.Fatalf("config = %v", config)
	}
	// `opencode` run directly has no launcher environment: the key is saved.
	if provider["options"].(map[string]any)["apiKey"] != "dak_1" || provider["env"] != nil {
		t.Fatalf("provider = %v", provider)
	}
	if first, err := Setup(dir, "http://127.0.0.1:7340", "dgw", models); err != nil || first {
		t.Fatalf("second setup = %v, %v", first, err)
	}

	removed, err := RemoveSetup(dir)
	if err != nil || !removed {
		t.Fatalf("remove = %v, %v", removed, err)
	}
	config, _ = readJSON(filepath.Join(dir, "opencode.json"))
	if config["model"] != "anthropic/claude-sonnet" || config["theme"] != "dark" || config["provider"] != nil || config["enabled_providers"] != nil {
		t.Fatalf("config after remove = %v", config)
	}
}

// A config Setup created goes away entirely on removal.
func TestRemoveSetupDeletesTheConfigItCreated(t *testing.T) {
	cacheHome(t)
	dir := t.TempDir()
	if _, err := Setup(dir, "https://routing.test", "dak_1", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := RemoveSetup(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "opencode.json")); !os.IsNotExist(err) {
		t.Fatalf("opencode.json remains: %v", err)
	}
}

// opencode.json with comments is left alone rather than rewritten without them.
func TestSetupRefusesAConfigWithComments(t *testing.T) {
	cacheHome(t)
	dir := t.TempDir()
	original := "{\n  // mine\n  \"theme\": \"dark\"\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "opencode.json"), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Setup(dir, "https://routing.test", "dak_1", agents.Models{Routing: true}); err == nil || !strings.Contains(err.Error(), "not plain JSON") {
		t.Fatalf("setup error = %v", err)
	}
	if body, _ := os.ReadFile(filepath.Join(dir, "opencode.json")); string(body) != original {
		t.Fatalf("opencode.json changed: %q", body)
	}
}

// A launch's own config still names the key's variable.
func TestLaunchConfigReferencesTheKeyVariable(t *testing.T) {
	config, err := openCodeConfig("https://routing.test", "/plugins", agents.Models{Routing: true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(config, `"apiKey":"{env:DARI_ROUTING_API_KEY}"`) || !strings.Contains(config, `"env":["DARI_ROUTING_API_KEY"]`) {
		t.Fatalf("config = %s", config)
	}
}

// OpenCode remembers the models used most recently; the latest Dari one is
// the user's pick.
func TestSavedModelReadsRecentModels(t *testing.T) {
	dir := t.TempDir()
	if SavedModel(dir) != "" {
		t.Fatal("no state has a saved model")
	}
	state := `{"recent":[{"providerID":"anthropic","modelID":"claude"},{"providerID":"dari","modelID":"model/a/two"}]}`
	if err := os.WriteFile(filepath.Join(dir, "model.json"), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := SavedModel(dir); got != "dari/model/a/two" {
		t.Fatalf("SavedModel = %q", got)
	}
}

// Setup adds Dari to the user's providers, plugins, and agents; removal takes
// out only Dari's entries, keeping ones the user added in between.
func TestSetupAddsToTheUsersOwnEntries(t *testing.T) {
	cacheHome(t)
	dir := t.TempDir()
	original := `{"plugins":["my-plugin"],"provider":{"local":{"name":"Local"}},"agent":{"general":{"temperature":0.2,"model":"local/x"},"build":{"prompt":"mine"}}}`
	if err := os.WriteFile(filepath.Join(dir, "opencode.json"), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Setup(dir, "https://routing.test", "dak_1", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	config, _ := readJSON(filepath.Join(dir, "opencode.json"))
	plugins := config["plugins"].([]any)
	providers := config["provider"].(map[string]any)
	general := config["agent"].(map[string]any)["general"].(map[string]any)
	if len(plugins) != 2 || plugins[0] != "my-plugin" || providers["local"] == nil || providers["dari"] == nil ||
		general["temperature"] != json.Number("0.2") || general["model"] != "dari/routing" {
		t.Fatalf("config = %v", config)
	}
	// A second launch adds nothing twice.
	if _, err := Setup(dir, "https://routing.test", "dak_1", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	config, _ = readJSON(filepath.Join(dir, "opencode.json"))
	if len(config["plugins"].([]any)) != 2 {
		t.Fatalf("plugins = %v", config["plugins"])
	}
	// The user adds a plugin while set up.
	config["plugins"] = append(config["plugins"].([]any), "later-plugin")
	if err := writeJSON(filepath.Join(dir, "opencode.json"), config); err != nil {
		t.Fatal(err)
	}

	if _, err := RemoveSetup(dir); err != nil {
		t.Fatal(err)
	}
	config, _ = readJSON(filepath.Join(dir, "opencode.json"))
	agentsConfig := config["agent"].(map[string]any)
	if got := config["plugins"].([]any); len(got) != 2 || got[0] != "my-plugin" || got[1] != "later-plugin" {
		t.Fatalf("plugins after remove = %v", got)
	}
	if providers := config["provider"].(map[string]any); providers["dari"] != nil || providers["local"] == nil {
		t.Fatalf("providers after remove = %v", providers)
	}
	if agentsConfig["general"].(map[string]any)["model"] != "local/x" || agentsConfig["build"] == nil || agentsConfig["explore"] != nil {
		t.Fatalf("agents after remove = %v", agentsConfig)
	}
}

// OpenCode's config model outranks its own recent models, so once the user
// has picked a Dari model, setup leaves model out and the pick wins.
func TestSetupLeavesModelToTheUsersPick(t *testing.T) {
	cacheHome(t)
	dir := t.TempDir()
	// The user's own pre-Dari default must not come back either.
	if err := os.WriteFile(filepath.Join(dir, "opencode.json"), []byte(`{"model":"anthropic/claude-sonnet"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models := agents.Models{Enabled: []string{"a/one", "a/two"}}
	if _, err := Setup(dir, "https://routing.test", "dak_1", models); err != nil {
		t.Fatal(err)
	}
	if config, _ := readJSON(filepath.Join(dir, "opencode.json")); config["model"] != "dari/model/a/one" {
		t.Fatalf("model before a pick = %v", config["model"])
	}
	models.Saved = "dari/model/a/two"
	if _, err := Setup(dir, "https://routing.test", "dak_1", models); err != nil {
		t.Fatal(err)
	}
	if config, _ := readJSON(filepath.Join(dir, "opencode.json")); config["model"] != nil {
		t.Fatalf("model after a pick = %v", config["model"])
	}
	if _, err := RemoveSetup(dir); err != nil {
		t.Fatal(err)
	}
	if config, _ := readJSON(filepath.Join(dir, "opencode.json")); config["model"] != "anthropic/claude-sonnet" {
		t.Fatalf("model after remove = %v", config["model"])
	}
}
