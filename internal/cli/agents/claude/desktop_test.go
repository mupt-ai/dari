package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/mupt-ai/dari-cli/internal/cli/agents"
)

func readTestJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	value := map[string]any{}
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestDesktopSetupAppliesDariEntryAndRemoveRestoresPrevious(t *testing.T) {
	dir := t.TempDir()
	library := filepath.Join(dir, "configLibrary")
	if err := os.MkdirAll(library, 0o700); err != nil {
		t.Fatal(err)
	}
	other := map[string]any{"id": "11111111-1111-4111-8111-111111111111", "name": "Bedrock"}
	meta, _ := json.Marshal(map[string]any{"appliedId": other["id"], "entries": []any{other}})
	if err := os.WriteFile(filepath.Join(library, "_meta.json"), meta, 0o600); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(settings, []byte(`{"env":{"FOO":"1"},"statusLine":{"command":"a && b"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models := agents.Models{Routing: true, Enabled: []string{"anthropic/claude-opus-5-5", "openai/gpt-6"}}

	if err := Setup(dir, settings, "https://routing.dari.dev/rtr_1", "dari_key", models); err != nil {
		t.Fatal(err)
	}
	entry := readTestJSON(t, filepath.Join(library, desktopEntryID+".json"))
	if entry["inferenceProvider"] != "gateway" || entry["inferenceGatewayBaseUrl"] != "https://routing.dari.dev/rtr_1" || entry["inferenceGatewayApiKey"] != "dari_key" {
		t.Fatalf("entry = %v", entry)
	}
	wantModels := []any{
		map[string]any{"name": "opus", "labelOverride": "Dari Routing"},
		map[string]any{"name": "dari/model/anthropic/claude-opus-5-5", "labelOverride": "anthropic/claude-opus-5-5"},
	}
	if !reflect.DeepEqual(entry["inferenceModels"], wantModels) {
		t.Fatalf("inferenceModels = %v, want %v", entry["inferenceModels"], wantModels)
	}
	gotMeta := readTestJSON(t, filepath.Join(library, "_meta.json"))
	if gotMeta["appliedId"] != desktopEntryID || len(gotMeta["entries"].([]any)) != 2 {
		t.Fatalf("meta = %v", gotMeta)
	}
	env := readTestJSON(t, settings)["env"].(map[string]any)
	if env[hintHeadersEnv] != "1" || env["FOO"] != "1" {
		t.Fatalf("settings env = %v", env)
	}

	removed, err := RemoveSetup(dir, settings)
	if err != nil || !removed {
		t.Fatalf("RemoveSetup() = %v, %v", removed, err)
	}
	gotMeta = readTestJSON(t, filepath.Join(library, "_meta.json"))
	if gotMeta["appliedId"] != other["id"] || !reflect.DeepEqual(gotMeta["entries"], []any{other}) {
		t.Fatalf("meta after remove = %v", gotMeta)
	}
	restored := readTestJSON(t, settings)
	if !reflect.DeepEqual(restored, map[string]any{"env": map[string]any{"FOO": "1"}, "statusLine": map[string]any{"command": "a && b"}}) {
		t.Fatalf("settings after remove = %v", restored)
	}
	if removed, err := RemoveSetup(dir, settings); err != nil || removed {
		t.Fatalf("second RemoveSetup() = %v, %v", removed, err)
	}
}

func TestDesktopSetupNeedsAClaudeModel(t *testing.T) {
	dir := t.TempDir()
	err := Setup(dir, filepath.Join(dir, "settings.json"), "https://routing.dari.dev", "dari_key", agents.Models{Enabled: []string{"openai/gpt-6"}})
	if err == nil {
		t.Fatal("Setup() succeeded without a Claude model")
	}
}
