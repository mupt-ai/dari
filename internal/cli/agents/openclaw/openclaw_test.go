package openclaw

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/mupt-ai/dari-cli/internal/cli/agents"
)

// fakeOpenClaw stands in for `openclaw config`: it serves the default model
// from model.json, reports the Dari provider once a patch has set it up, and
// records each patch with its flags.
const fakeOpenClaw = `#!/bin/sh
dir=$(dirname "$0")
unset_path() { printf '{"ok":false,"error":{"message":"Config path is valid but unset: %s."}}\n' "$1"; exit 1; }
case "$1 $2" in
"config file") echo "$dir/openclaw.json" ;;
"config get")
  case "$3" in
  agents.defaults.model) [ -f "$dir/model.json" ] && cat "$dir/model.json" || unset_path "$3" ;;
  models.providers.dari) [ -f "$dir/provider" ] && echo '{}' || unset_path "$3" ;;
  *) exit 2 ;;
  esac ;;
"config patch")
  n=$(ls "$dir" | grep -c '^patch-')
  cat > "$dir/patch-$n.json"
  shift 3
  echo "$*" > "$dir/flags-$n"
  grep -q '"dari":null' "$dir/patch-$n.json" && rm -f "$dir/provider" || touch "$dir/provider" ;;
*) exit 2 ;;
esac
`

func TestSetupMakesDariTheDefaultAndRemoveRestoresIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a shell script as OpenClaw")
	}
	dir := t.TempDir()
	executable := filepath.Join(dir, "openclaw")
	if err := os.WriteFile(executable, []byte(fakeOpenClaw), 0o700); err != nil {
		t.Fatal(err)
	}
	writeModel := func(model string) {
		if err := os.WriteFile(filepath.Join(dir, "model.json"), []byte(model), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeModel(`{"primary":"openai/gpt-6","fallbacks":["anthropic/claude-sonnet-4-6"]}`)
	ctx := context.Background()

	if err := Setup(ctx, executable, "https://routing.dari.dev/rtr_1", "dari_key", agents.Models{Routing: true, Enabled: []string{"openai/gpt-6.1-sol"}}); err != nil {
		t.Fatal(err)
	}
	var patch struct {
		Models struct {
			Providers map[string]struct {
				BaseURL string `json:"baseUrl"`
				APIKey  string `json:"apiKey"`
				API     string `json:"api"`
				Models  []struct {
					ID        string          `json:"id"`
					Reasoning bool            `json:"reasoning"`
					Compat    map[string]bool `json:"compat"`
				} `json:"models"`
			} `json:"providers"`
		} `json:"models"`
		Agents struct {
			Defaults struct {
				Model map[string]any `json:"model"`
			} `json:"defaults"`
		} `json:"agents"`
	}
	readJSON(t, filepath.Join(dir, "patch-0.json"), &patch)
	dari := patch.Models.Providers["dari"]
	if dari.BaseURL != "https://routing.dari.dev/rtr_1/v1" || dari.APIKey != "dari_key" || dari.API != "openai-completions" {
		t.Fatalf("provider = %+v", dari)
	}
	if len(dari.Models) != 2 || dari.Models[0].ID != "dari/routing" || dari.Models[0].Reasoning || !dari.Models[1].Reasoning || !dari.Models[0].Compat["sendSessionAffinityHeaders"] ||
		dari.Models[0].Compat["supportsReasoningEffort"] || !dari.Models[1].Compat["supportsReasoningEffort"] {
		t.Fatalf("models = %+v", dari.Models)
	}
	// Only the primary changes, so fallbacks the user configured remain.
	if want := map[string]any{"primary": "dari/dari/routing"}; !reflect.DeepEqual(patch.Agents.Defaults.Model, want) {
		t.Fatalf("model patch = %#v, want %#v", patch.Agents.Defaults.Model, want)
	}
	if flags := readFile(t, filepath.Join(dir, "flags-0")); flags != "--replace-path models.providers.dari\n" {
		t.Fatalf("patch flags = %q", flags)
	}

	// Setting up again keeps the model Dari first replaced.
	writeModel(`{"primary":"dari/dari/routing"}`)
	if err := Setup(ctx, executable, "https://routing.dari.dev/rtr_1", "dari_key", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}

	removed, err := RemoveSetup(ctx, executable)
	if err != nil || !removed {
		t.Fatalf("RemoveSetup() = %v, %v", removed, err)
	}
	var restore map[string]any
	readJSON(t, filepath.Join(dir, "patch-2.json"), &restore)
	want := map[string]any{
		"models": map[string]any{"providers": map[string]any{"dari": nil}},
		"agents": map[string]any{"defaults": map[string]any{"model": map[string]any{"primary": "openai/gpt-6"}}},
	}
	if !reflect.DeepEqual(restore, want) {
		t.Fatalf("remove patch = %#v, want %#v", restore, want)
	}
	if _, err := os.Stat(filepath.Join(dir, setupFile)); !os.IsNotExist(err) {
		t.Fatalf("setup record remains: %v", err)
	}
	if removed, err := RemoveSetup(ctx, executable); err != nil || removed {
		t.Fatalf("second RemoveSetup() = %v, %v", removed, err)
	}
}

func readJSON(t *testing.T, path string, value any) {
	t.Helper()
	if err := json.Unmarshal([]byte(readFile(t, path)), value); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
