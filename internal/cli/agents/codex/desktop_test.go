package codex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupReplacesTopLevelModelAndRemoveRestoresConfig(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.toml")
	original := "model = \"gpt-6\"\napproval_policy = \"never\"\n\n[profiles.fast]\nmodel = \"o3\"\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if err := Setup(home, "https://routing.dari.dev/rtr_1", "dari_key", "dari/routing", []byte(`{"models":[]}`), true); err != nil {
			t.Fatal(err)
		}
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	config := string(body)
	for _, want := range []string{
		"model = \"dari/routing\"\n",
		"model_provider = \"dari\"\n",
		"model_catalog_json = \"" + filepath.Join(home, catalogFile) + "\"\n",
		"web_search = \"disabled\"\n",
		"# dari codex --setup: model = \"gpt-6\"\n",
		"[profiles.fast]\nmodel = \"o3\"\n",
		"base_url = \"https://routing.dari.dev/rtr_1/v1\"\n",
		"experimental_bearer_token = \"dari_key\"\n",
	} {
		if !strings.Contains(config, want) {
			t.Errorf("config missing %q:\n%s", want, config)
		}
	}
	if strings.Count(config, "[model_providers.dari]") != 1 {
		t.Fatalf("setup is not idempotent:\n%s", config)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %v, %v; want 0600", info.Mode().Perm(), err)
	}

	removed, err := RemoveSetup(home)
	if err != nil || !removed {
		t.Fatalf("RemoveSetup() = %v, %v", removed, err)
	}
	body, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != original {
		t.Fatalf("restored config = %q, want %q", body, original)
	}
	if _, err := os.Stat(filepath.Join(home, catalogFile)); !os.IsNotExist(err) {
		t.Fatalf("catalog still exists: %v", err)
	}
	if removed, err := RemoveSetup(home); err != nil || removed {
		t.Fatalf("second RemoveSetup() = %v, %v", removed, err)
	}
}

func TestSetupRefusesDariProviderHeadersWithCommentsOrQuotes(t *testing.T) {
	for _, header := range []string{
		"[model_providers.dari] # mine",
		"[ model_providers.\"dari\" ]",
		"[model_providers.dari.auth]",
	} {
		_, err := setupConfig(header+"\nname = \"x\"\n", "https://routing.dari.dev", "dari_key", "dari/routing", "/catalog.json", false)
		if err == nil || !strings.Contains(err.Error(), "already defines") {
			t.Errorf("setupConfig(%q) error = %v, want refusal", header, err)
		}
	}
	if _, err := setupConfig("[model_providers.other]\nname = \"x\"\n", "https://routing.dari.dev", "dari_key", "dari/routing", "/catalog.json", false); err != nil {
		t.Errorf("unrelated provider table refused: %v", err)
	}
}

func TestSetupDisablesTopLevelProfileAndRestoresIt(t *testing.T) {
	config, err := setupConfig("profile = \"work\"\n", "https://routing.dari.dev", "dari_key", "dari/routing", "/catalog.json", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(config, "# dari codex --setup: profile = \"work\"\n") {
		t.Fatalf("profile was not disabled:\n%s", config)
	}
	if got := removeSetup(config); got != "profile = \"work\"\n" {
		t.Fatalf("removeSetup() = %q", got)
	}
}

func TestSetupKeepsWebSearchUnlessItDisablesIt(t *testing.T) {
	config, err := setupConfig("web_search = \"cached\"\n", "https://routing.dari.dev", "dari_key", "dari/routing", "/catalog.json", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(config, "\nweb_search = \"cached\"\n") || strings.Contains(config, setupDisabled) {
		t.Fatalf("web_search was replaced:\n%s", config)
	}
}

func TestRemoveSetupDeletesConfigItCreated(t *testing.T) {
	home := t.TempDir()
	if err := Setup(home, "https://routing.dari.dev", "dari_key", "dari/routing", []byte(`{}`), false); err != nil {
		t.Fatal(err)
	}
	if _, err := RemoveSetup(home); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "config.toml")); !os.IsNotExist(err) {
		t.Fatalf("config.toml still exists: %v", err)
	}
}

func TestSetupRefusesUserDefinedDariProvider(t *testing.T) {
	home := t.TempDir()
	original := "[model_providers.dari]\nbase_url = \"https://example.test\"\n"
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	err := Setup(home, "https://routing.dari.dev", "dari_key", "dari/routing", []byte(`{}`), false)
	if err == nil || !strings.Contains(err.Error(), "[model_providers.dari]") {
		t.Fatalf("Setup() error = %v", err)
	}
}

// Codex's /model edits the model inside the setup block, and Codex appends
// the tables it adds inside the trailing block; a later setup or removal
// keeps them.
func TestSetupKeepsWhatCodexAddedInsideItsBlocks(t *testing.T) {
	config, err := setupConfig("", "https://routing.dari.dev", "dak_1", "dari/routing", "/tmp/catalog.json", false)
	if err != nil {
		t.Fatal(err)
	}
	// What Codex leaves after /model picks another model.
	config = strings.Replace(config, `model = "dari/routing"`, `model = "dari/model/a/b"`, 1)
	config = strings.TrimSuffix(config, setupEnd+"\n") + "\n[tui]\nscreen_reader_detection_done = true\n" + setupEnd + "\n"

	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := SavedModel(home); got != "dari/model/a/b" {
		t.Fatalf("SavedModel = %q", got)
	}
	again, err := setupConfig(config, "http://127.0.0.1:7340", "dgw", SavedModel(home), "/tmp/catalog.json", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(again, "[tui]\nscreen_reader_detection_done = true") || !strings.Contains(again, `model = "dari/model/a/b"`) {
		t.Fatalf("setup dropped Codex's additions:\n%s", again)
	}
	if removed := removeSetup(again); !strings.Contains(removed, "[tui]") || strings.Contains(removed, "model_providers.dari") {
		t.Fatalf("removal = %q", removed)
	}
}
