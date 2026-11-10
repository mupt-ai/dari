package claude

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

func writeSettings(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// Every launch writes Dari into Claude Code's settings so `claude` itself
// routes through Dari; the user's own values come back on removal.
func TestCLISetupRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeSettings(t, path, `{"model":"opus","theme":"dark","env":{"ANTHROPIC_API_KEY":"sk-user","OTHER":"1"}}`)
	models := agents.Models{Enabled: []string{"anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"}}

	first, err := CLISetup(path, "https://routing.dari.dev", "dak_1", models)
	if err != nil || !first {
		t.Fatalf("first setup = %v, %v", first, err)
	}
	settings, _ := readJSON(path)
	env := settings["env"].(map[string]any)
	if settings["model"] != "dari/model/anthropic/claude-sonnet-5-5" || env["ANTHROPIC_BASE_URL"] != "https://routing.dari.dev" ||
		env["ANTHROPIC_AUTH_TOKEN"] != "dak_1" || env["ANTHROPIC_API_KEY"] != "" || env["OTHER"] != "1" {
		t.Fatalf("settings after setup = %v", settings)
	}
	if settings["modelPicker"] == nil || settings["statusLine"] == nil || settings["theme"] != "dark" {
		t.Fatalf("settings after setup = %v", settings)
	}

	// The next launch (say, after switching to a local gateway) refreshes the
	// values but keeps the record of the user's originals.
	models.Saved = "dari/model/anthropic/claude-opus-5-5"
	first, err = CLISetup(path, "http://127.0.0.1:7340", "dgw_local", models)
	if err != nil || first {
		t.Fatalf("second setup = %v, %v", first, err)
	}
	settings, _ = readJSON(path)
	if settings["model"] != "dari/model/anthropic/claude-opus-5-5" || settings["env"].(map[string]any)["ANTHROPIC_AUTH_TOKEN"] != "dgw_local" {
		t.Fatalf("settings after refresh = %v", settings)
	}

	removed, err := RemoveCLISetup(path)
	if err != nil || !removed {
		t.Fatalf("remove = %v, %v", removed, err)
	}
	settings, _ = readJSON(path)
	env = settings["env"].(map[string]any)
	if settings["model"] != "opus" || env["ANTHROPIC_API_KEY"] != "sk-user" || env["OTHER"] != "1" || env["ANTHROPIC_BASE_URL"] != nil {
		t.Fatalf("settings after remove = %v", settings)
	}
	if settings["modelPicker"] != nil || settings["statusLine"] != nil || settings["theme"] != "dark" {
		t.Fatalf("settings after remove = %v", settings)
	}
	if removed, _ := RemoveCLISetup(path); removed {
		t.Fatal("a second removal found a setup")
	}
}

// A status line the user set before Dari stays theirs.
func TestCLISetupKeepsTheUsersStatusLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeSettings(t, path, `{"statusLine":{"type":"command","command":"my-status"}}`)
	if _, err := CLISetup(path, "https://routing.dari.dev", "dak_1", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	settings, _ := readJSON(path)
	if settings["statusLine"].(map[string]any)["command"] != "my-status" {
		t.Fatalf("statusLine = %v", settings["statusLine"])
	}
}

// A Dari model saved before setup (by /model in a `dari claude` session) is
// not restored: plain `claude` would ask Anthropic for it.
func TestRemoveCLISetupDropsADariModel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeSettings(t, path, `{"model":"dari/model/anthropic/claude-opus-5-5"}`)
	if _, err := CLISetup(path, "https://routing.dari.dev", "dak_1", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := RemoveCLISetup(path); err != nil {
		t.Fatal(err)
	}
	if settings, _ := readJSON(path); settings["model"] != nil {
		t.Fatalf("model = %v", settings["model"])
	}
}

func TestSavedModel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if SavedModel(path) != "" {
		t.Fatal("missing settings have a saved model")
	}
	writeSettings(t, path, `{"model":"dari/model/anthropic/claude-opus-5-5"}`)
	if got := SavedModel(path); got != "dari/model/anthropic/claude-opus-5-5" {
		t.Fatalf("SavedModel = %q", got)
	}
}
