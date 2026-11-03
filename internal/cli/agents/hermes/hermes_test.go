package hermes

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/mupt-ai/dari-cli/internal/cli/agents"
)

func TestSetupMakesDariTheMainModelAndRemoveRestoresIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	original := `# my Hermes setup
model:
  provider: "custom"
  default: "qwen3.6-27b"
  base_url: "http://127.0.0.1:11434/v1"
  context_length: 65536
  aliases:
    fast: qwen3.6-27b
providers:
  local:
    api: http://127.0.0.1:8080/v1
terminal:
  backend: local # keep me
`
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	models := agents.Models{Routing: true, Enabled: []string{"openai/gpt-6.1-sol"}}
	for range 2 {
		if err := Setup(path, "https://routing.dari.dev/rtr_1", "dari_key", models); err != nil {
			t.Fatal(err)
		}
	}

	config := readYAML(t, path)
	model := config["model"].(map[string]any)
	wantModel := map[string]any{"provider": "dari", "default": "dari/routing", "aliases": map[string]any{"fast": "qwen3.6-27b"}}
	if !reflect.DeepEqual(model, wantModel) {
		t.Fatalf("model = %#v, want %#v", model, wantModel)
	}
	providers := config["providers"].(map[string]any)
	if _, ok := providers["local"]; !ok {
		t.Fatalf("setup dropped another provider: %#v", providers)
	}
	dari := providers["dari"].(map[string]any)
	for field, want := range map[string]any{
		"base_url":                "https://routing.dari.dev/rtr_1/v1",
		"api_key":                 "dari_key",
		"transport":               "chat_completions",
		"default_model":           "dari/routing",
		"session_affinity_header": "x-session-affinity",
	} {
		if dari[field] != want {
			t.Errorf("providers.dari.%s = %#v, want %#v", field, dari[field], want)
		}
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Index(string(body), "dari/routing: {}") > strings.Index(string(body), "dari/model/openai/gpt-6.1-sol: {}") {
		t.Fatalf("models are not in menu order:\n%s", body)
	}
	for _, comment := range []string{"# my Hermes setup", "# keep me"} {
		if !strings.Contains(string(body), comment) {
			t.Errorf("setup dropped comment %q:\n%s", comment, body)
		}
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %v, %v; want 0600", info.Mode().Perm(), err)
	}

	removed, err := RemoveSetup(path)
	if err != nil || !removed {
		t.Fatalf("RemoveSetup() = %v, %v", removed, err)
	}
	var want map[string]any
	if err := yaml.Unmarshal([]byte(original), &want); err != nil {
		t.Fatal(err)
	}
	if got := readYAML(t, path); !reflect.DeepEqual(got, want) {
		t.Fatalf("restored config = %#v, want %#v", got, want)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), setupFile)); !os.IsNotExist(err) {
		t.Fatalf("setup record remains: %v", err)
	}
	if removed, err := RemoveSetup(path); err != nil || removed {
		t.Fatalf("second RemoveSetup() = %v, %v", removed, err)
	}
}

func TestSetupWithoutConfigLeavesNothingAfterRemove(t *testing.T) {
	path := filepath.Join(t.TempDir(), "home", "config.yaml")
	if err := Setup(path, "https://routing.dari.dev", "dari_key", agents.Models{Enabled: []string{"openai/gpt-6.1-sol"}}); err != nil {
		t.Fatal(err)
	}
	if model := readYAML(t, path)["model"].(map[string]any); model["default"] != "dari/model/openai/gpt-6.1-sol" {
		t.Fatalf("model = %#v", model)
	}
	if removed, err := RemoveSetup(path); err != nil || !removed {
		t.Fatalf("RemoveSetup() = %v, %v", removed, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("config remains after removing the only setup: %v", err)
	}
}

func readYAML(t *testing.T, path string) map[string]any {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := yaml.Unmarshal(body, &config); err != nil {
		t.Fatal(err)
	}
	return config
}
