package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestRouterCommandsUseAPIKeyRoutes(t *testing.T) {
	seen := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		seen[r.Method+" "+r.URL.Path] = true
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []any{map[string]any{"id": "rtr_123"}}})
		case "/v1/organizations/current/routers/rtr_123":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_123", "name": "Production"})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	useTestAPIKey(t)

	for _, args := range [][]string{
		{"--api-url", srv.URL, "router", "list"},
		{"--api-url", srv.URL, "router", "get", "https://routing.dari.dev/rtr_123/chat/completions"},
	} {
		cmd := newRootCmd("dev")
		cmd.SetArgs(args)
		if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
			t.Fatalf("dari %v: %v", args, err)
		}
	}

	for _, want := range []string{
		"GET /v1/organizations/current/routers",
		"GET /v1/organizations/current/routers/rtr_123",
	} {
		if !seen[want] {
			t.Fatalf("did not see request %s", want)
		}
	}
}

func TestRouterModelsUsesModelCatalogRoute(t *testing.T) {
	seen := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		seen[r.Method+" "+r.URL.Path] = true
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"groups": []any{}})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "models"})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router models: %v", err)
	}
	if !seen["GET /v1/organizations/current/routers/model-catalog"] {
		t.Fatalf("did not see model-catalog request; saw %v", seen)
	}
}

func TestRouterCreateSendsPayload(t *testing.T) {
	t.Setenv("TEST_FIREWORKS_KEY", "sk-fireworks-env")
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/organizations/current/routers" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_new"})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"--api-url", srv.URL, "router", "create", "Production Router",
		"--model", "fireworks/deepseek-ai/DeepSeek-V4-Pro,fireworks/deepseek-ai/DeepSeek-V4-Flash",
		"--provider-key-env", "fireworks=TEST_FIREWORKS_KEY",
		"--strategy", "dari",
	})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router create: %v", err)
	}

	want := map[string]any{
		"name":             "Production Router",
		"enabled_models":   []any{"fireworks/deepseek-ai/DeepSeek-V4-Pro", "fireworks/deepseek-ai/DeepSeek-V4-Flash"},
		"provider_keys":    map[string]any{"fireworks": "sk-fireworks-env"},
		"routing_strategy": "dari",
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("create body = %#v, want %#v", body, want)
	}
}

func TestRouterCreateManualFlagsAllowPathLikeNames(t *testing.T) {
	for _, name := range []string{"Team/Prod", "draft.yaml"} {
		t.Run(name, func(t *testing.T) {
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/organizations/current/routers" {
					t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				raw, _ := io.ReadAll(r.Body)
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatalf("decode body: %v", err)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_new"})
			}))
			defer srv.Close()
			useTestAPIKey(t)

			cmd := newRootCmd("dev")
			cmd.SetArgs([]string{
				"--api-url", srv.URL, "router", "create", name,
				"--model", "openai/gpt-5.5",
				"--managed-key", "openai",
			})
			if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
				t.Fatalf("dari router create %q: %v", name, err)
			}
			want := map[string]any{
				"name":                 name,
				"enabled_models":       []any{"openai/gpt-5.5"},
				"provider_key_sources": map[string]any{"openai": "managed"},
			}
			if !reflect.DeepEqual(body, want) {
				t.Fatalf("create body = %#v, want %#v", body, want)
			}
		})
	}
}

func TestRouterCreateFromManifestFileSendsPayload(t *testing.T) {
	t.Setenv("TEST_BASETEN_KEY", "sk-baseten-env")
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "router.yml")
	if err := os.WriteFile(manifestPath, []byte(`name: Production Router
enabled_models:
  - openai/gpt-5.5
  - baseten/moonshotai/Kimi-K2.7-Code
provider_key_sources:
  openai: managed
  baseten: user
provider_key_envs:
  baseten: TEST_BASETEN_KEY
routing_strategy: dari
`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/organizations/current/routers" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_new"})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "create", "--from-file", manifestPath})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router create --from-file: %v", err)
	}

	want := map[string]any{
		"name":                 "Production Router",
		"enabled_models":       []any{"openai/gpt-5.5", "baseten/moonshotai/Kimi-K2.7-Code"},
		"provider_keys":        map[string]any{"baseten": "sk-baseten-env"},
		"provider_key_sources": map[string]any{"openai": "managed", "baseten": "user"},
		"routing_strategy":     "dari",
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("create body = %#v, want %#v", body, want)
	}
}

func TestRouterCreateSendsEvalScoreImputationOnlyWhenSet(t *testing.T) {
	dir := t.TempDir()
	writeManifest := func(name, extra string) string {
		path := filepath.Join(dir, name)
		content := "name: Manifest Router\nenabled_models:\n  - openai/gpt-5.5\nprovider_key_sources:\n  openai: managed\n" + extra
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write manifest: %v", err)
		}
		return path
	}
	flagArgs := []string{"router", "create", "Flag Router", "--model", "openai/gpt-5.5", "--managed-key", "openai"}
	tests := []struct {
		name string
		args []string
		want any // nil means the field is omitted so the API default (on) applies
	}{
		{name: "flag omitted", args: flagArgs},
		{name: "flag false", args: append(slices.Clone(flagArgs), "--eval-score-imputation=false"), want: false},
		{name: "flag true", args: append(slices.Clone(flagArgs), "--eval-score-imputation"), want: true},
		{name: "manifest omitted", args: []string{"router", "create", "--from-file", writeManifest("omitted.yml", "")}},
		{name: "manifest false", args: []string{"router", "create", "--from-file", writeManifest("off.yml", "eval_score_imputation: false\n")}, want: false},
		{name: "manifest true", args: []string{"router", "create", "--from-file", writeManifest("on.yml", "eval_score_imputation: true\n")}, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/organizations/current/routers" {
					t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				raw, _ := io.ReadAll(r.Body)
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatalf("decode body: %v", err)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_new"})
			}))
			defer srv.Close()
			useTestAPIKey(t)

			cmd := newRootCmd("dev")
			cmd.SetArgs(append([]string{"--api-url", srv.URL}, tt.args...))
			if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
				t.Fatalf("dari router create: %v", err)
			}
			got, present := body["eval_score_imputation"]
			if tt.want == nil {
				if present {
					t.Fatalf("eval_score_imputation = %#v, want omitted", got)
				}
				return
			}
			if got != tt.want {
				t.Fatalf("eval_score_imputation = %#v (present %v), want %#v", got, present, tt.want)
			}
		})
	}
}

func TestRouterCreateSendsSessionPinningAndNativeCompaction(t *testing.T) {
	manifestPath := filepath.Join(t.TempDir(), "router.yml")
	manifest := "name: Manifest Router\nenabled_models:\n  - openai/gpt-5.5\nprovider_key_sources:\n  openai: managed\nsession_pinning: true\nnative_compaction: true\n"
	if err := os.WriteFile(manifestPath, []byte(manifest), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	tests := []struct {
		name string
		args []string
		want any // nil means the field is omitted
	}{
		{name: "flag omitted", args: []string{"router", "create", "Flag Router", "--model", "openai/gpt-5.5", "--managed-key", "openai"}},
		{name: "flag set", args: []string{"router", "create", "Flag Router", "--model", "openai/gpt-5.5", "--managed-key", "openai", "--session-pinning", "--native-compaction"}, want: true},
		{name: "manifest", args: []string{"router", "create", "--from-file", manifestPath}, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatalf("decode body: %v", err)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_new"})
			}))
			defer srv.Close()
			useTestAPIKey(t)

			cmd := newRootCmd("dev")
			cmd.SetArgs(append([]string{"--api-url", srv.URL}, tt.args...))
			if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
				t.Fatalf("dari router create: %v", err)
			}
			for _, field := range []string{"session_pinning", "native_compaction"} {
				if got := body[field]; got != tt.want {
					t.Fatalf("%s = %#v, want %#v", field, got, tt.want)
				}
			}
		})
	}
}

func TestRouterCreateFromManifestRejectsLegacyEvalIDs(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "router.yml")
	if err := os.WriteFile(manifestPath, []byte(`name: Legacy Router
enabled_models:
  - openai/gpt-5.5
eval_ids:
  - evl_123
`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"router", "create", manifestPath})
	cmd.SetErr(io.Discard)
	err := captureStdout(t, func() error { return cmd.Execute() })
	if err == nil || !strings.Contains(err.Error(), "field eval_ids not found") {
		t.Fatalf("error = %v, want clear unknown eval_ids field error", err)
	}
}

func TestRouterCreateFromManifestCustomStrategySendsPayload(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "router.yml")
	if err := os.WriteFile(manifestPath, []byte(`name: Custom Rules Router
enabled_models:
  - openai/gpt-5.5
  - openai/gpt-4.1-mini
model_thinking_levels:
  openai/gpt-5.5: [high, low]
  openai/gpt-4.1-mini: [off]
provider_key_sources:
  openai: managed
routing_strategy: custom
custom_config:
  rules:
    - when: " planning and architecture "
      use: openai/gpt-5.5
      thinking_level: high
    - when: implementation and refactors
      use: " openai/gpt-4.1-mini "
      thinking_level: null
  default: " openai/gpt-4.1-mini "
  default_thinking_level: null
`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/organizations/current/routers" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_new"})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "create", "--from-file", manifestPath})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router create --from-file: %v", err)
	}

	want := map[string]any{
		"name":           "Custom Rules Router",
		"enabled_models": []any{"openai/gpt-5.5", "openai/gpt-4.1-mini"},
		"model_thinking_levels": map[string]any{
			"openai/gpt-5.5":      []any{"low", "high"},
			"openai/gpt-4.1-mini": []any{"off"},
		},
		"provider_key_sources": map[string]any{"openai": "managed"},
		"routing_strategy":     "custom",
		"custom_config": map[string]any{
			"rules": []any{
				map[string]any{
					"when":           "planning and architecture",
					"use":            "openai/gpt-5.5",
					"thinking_level": "high",
				},
				map[string]any{"when": "implementation and refactors", "use": "openai/gpt-4.1-mini"},
			},
			"default": "openai/gpt-4.1-mini",
		},
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("create body = %#v, want %#v", body, want)
	}
}

func TestRouterCreateFromManifestSendsFastModels(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "router.yml")
	if err := os.WriteFile(manifestPath, []byte(`name: Fast Sol Router
enabled_models:
  - openai/gpt-5.6-sol
model_thinking_levels:
  openai/gpt-5.6-sol: [max, off, high, low, medium, xhigh]
fast_models:
  - openai/gpt-5.6-sol
provider_key_sources:
  openai: managed
`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"groups":[]}`))
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_new"})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "create", manifestPath})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router create --from-file: %v", err)
	}

	wantThinkingLevels := map[string]any{
		"openai/gpt-5.6-sol": []any{"off", "low", "medium", "high", "xhigh", "max"},
	}
	if !reflect.DeepEqual(body["model_thinking_levels"], wantThinkingLevels) {
		t.Fatalf("model_thinking_levels = %#v, want %#v", body["model_thinking_levels"], wantThinkingLevels)
	}
	wantFastModels := []any{"openai/gpt-5.6-sol"}
	if !reflect.DeepEqual(body["fast_models"], wantFastModels) {
		t.Fatalf("fast_models = %#v, want %#v", body["fast_models"], wantFastModels)
	}
}

func TestRouterCreateFromManifestDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "router.yaml"), []byte(`name: Managed Router
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  openai: managed
routing_strategy: dari
`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"groups":[]}`))
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_new"})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "create", dir})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router create <dir>: %v", err)
	}
	want := map[string]any{
		"name":                 "Managed Router",
		"enabled_models":       []any{"openai/gpt-5.5"},
		"provider_key_sources": map[string]any{"openai": "managed"},
		"routing_strategy":     "dari",
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("create body = %#v, want %#v", body, want)
	}
}

func TestRouterCreateFromManifestValidatesRequiredFieldsBeforeAPI(t *testing.T) {
	t.Setenv("TEST_BASETEN_KEY", "sk-baseten")

	for _, tc := range []struct {
		name     string
		manifest string
	}{
		{
			name: "missing name",
			manifest: `enabled_models:
  - openai/gpt-5.5
`,
		},
		{
			name: "missing enabled_models",
			manifest: `name: Missing Models
`,
		},
		{
			name:     "empty manifest",
			manifest: "",
		},
		{
			name: "missing provider_key_sources",
			manifest: `name: Missing Sources
enabled_models:
  - openai/gpt-5.5
`,
		},
		{
			name: "model missing provider prefix",
			manifest: `name: Slashless Model
enabled_models:
  - gpt-5.5
provider_key_sources:
  openai: managed
`,
		},
		{
			name: "extra provider key source",
			manifest: `name: Extra Source
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  openai: managed
  baseten: managed
`,
		},
		{
			name: "provider key for managed provider",
			manifest: `name: Bad Router
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  openai: managed
provider_keys:
  openai: sk-openai
`,
		},
		{
			name: "extra provider key",
			manifest: `name: Extra Key
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  openai: managed
provider_keys:
  baseten: sk-baseten
`,
		},
		{
			name: "extra provider key env",
			manifest: `name: Extra Key Env
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  openai: managed
provider_key_envs:
  baseten: TEST_BASETEN_KEY
`,
		},
		{
			name: "custom provider inline key",
			manifest: `name: Custom Inline Key
enabled_models:
  - acme/qwen3-coder
provider_key_sources:
  acme: user
provider_keys:
  acme: sk-acme
`,
		},
		{
			name: "custom provider managed source",
			manifest: `name: Custom Managed Source
enabled_models:
  - acme/qwen3-coder
provider_key_sources:
  acme: managed
`,
		},
		{
			name: "custom strategy missing config",
			manifest: `name: Missing Custom Config
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  openai: managed
routing_strategy: custom
`,
		},
		{
			name: "custom config with dari strategy",
			manifest: `name: Wrong Custom Strategy
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  openai: managed
routing_strategy: dari
custom_config:
  rules:
    - when: planning
      use: openai/gpt-5.5
`,
		},
		{
			name: "custom rule model not enabled",
			manifest: `name: Unknown Rule Model
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  openai: managed
routing_strategy: custom
custom_config:
  rules:
    - when: implementation
      use: openai/gpt-4.1-mini
`,
		},
		{
			name: "custom rules empty",
			manifest: `name: Empty Custom Rules
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  openai: managed
routing_strategy: custom
custom_config:
  rules: []
`,
		},
		{
			name: "custom default model not enabled",
			manifest: `name: Unknown Custom Default
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  openai: managed
routing_strategy: custom
custom_config:
  rules:
    - when: planning
      use: openai/gpt-5.5
  default: openai/gpt-4.1-mini
`,
		},
		{
			name: "model thinking levels missing enabled model",
			manifest: `name: Missing Pair Config
enabled_models:
  - openai/gpt-5.5
  - openai/gpt-4.1-mini
model_thinking_levels:
  openai/gpt-5.5: [high]
provider_key_sources:
  openai: managed
`,
		},
		{
			name: "model thinking levels include disabled model",
			manifest: `name: Extra Pair Config
enabled_models:
  - openai/gpt-5.5
model_thinking_levels:
  openai/gpt-5.5: [high]
  openai/gpt-4.1-mini: [off]
provider_key_sources:
  openai: managed
`,
		},
		{
			name: "model thinking levels empty",
			manifest: `name: Empty Pair Config
enabled_models:
  - openai/gpt-5.5
model_thinking_levels:
  openai/gpt-5.5: []
provider_key_sources:
  openai: managed
`,
		},
		{
			name: "model thinking level invalid",
			manifest: `name: Invalid Pair Config
enabled_models:
  - openai/gpt-5.5
model_thinking_levels:
  openai/gpt-5.5: [turbo]
provider_key_sources:
  openai: managed
`,
		},
		{
			name: "fast model not enabled",
			manifest: `name: Invalid Fast Model
enabled_models:
  - openai/gpt-5.6-sol
fast_models:
  - openai/gpt-5.6-terra
provider_key_sources:
  openai: managed
`,
		},
		{
			name: "custom rule thinking level not enabled",
			manifest: `name: Invalid Rule Pair
enabled_models:
  - openai/gpt-5.5
model_thinking_levels:
  openai/gpt-5.5: [low]
provider_key_sources:
  openai: managed
routing_strategy: custom
custom_config:
  rules:
    - when: planning
      use: openai/gpt-5.5
      thinking_level: high
`,
		},
		{
			name: "custom default thinking level without default",
			manifest: `name: Invalid Auto Fallback
enabled_models:
  - openai/gpt-5.5
model_thinking_levels:
  openai/gpt-5.5: [high]
provider_key_sources:
  openai: managed
routing_strategy: custom
custom_config:
  rules:
    - when: planning
      use: openai/gpt-5.5
  default_thinking_level: high
`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			manifestPath := filepath.Join(dir, "router.yml")
			if err := os.WriteFile(manifestPath, []byte(tc.manifest), 0o644); err != nil {
				t.Fatalf("write manifest: %v", err)
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// Provider-mismatch validation may consult the model catalog
				// for default providers; an invalid manifest must still never
				// reach the create endpoint.
				if r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog" {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"groups":[]}`))
					return
				}
				t.Fatalf("unexpected API request %s %s", r.Method, r.URL.Path)
			}))
			defer srv.Close()
			useTestAPIKey(t)

			cmd := newRootCmd("dev")
			cmd.SetArgs([]string{"--api-url", srv.URL, "router", "create", manifestPath})
			cmd.SetErr(io.Discard)
			if err := captureStdout(t, func() error { return cmd.Execute() }); err == nil {
				t.Fatal("expected manifest validation error")
			}
		})
	}
}

func TestRouterCreateFromManifestNormalizesProviderCase(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "router.yml"), []byte(`name: Case Router
enabled_models:
  - openai/gpt-5.5
provider_key_sources:
  OpenAI: Managed
routing_strategy: DARI
`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"groups":[]}`))
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_new"})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "create", dir})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router create <dir>: %v", err)
	}
	want := map[string]any{"openai": "managed"}
	if !reflect.DeepEqual(body["provider_key_sources"], want) {
		t.Fatalf("provider_key_sources = %#v, want %#v", body["provider_key_sources"], want)
	}
	if body["routing_strategy"] != "dari" {
		t.Fatalf("routing_strategy = %#v, want %q", body["routing_strategy"], "dari")
	}
}

func TestRouterCreateFromManifestAllowsCustomModelCredentialProviders(t *testing.T) {
	for _, tc := range []struct {
		name     string
		manifest string
		want     map[string]any
	}{
		{
			name: "no provider key fields",
			manifest: `name: Custom Router
enabled_models:
  - acme/qwen3-coder
`,
			want: map[string]any{
				"name":           "Custom Router",
				"enabled_models": []any{"acme/qwen3-coder"},
			},
		},
		{
			name: "user source without inline key",
			manifest: `name: Custom Router
enabled_models:
  - acme/qwen3-coder
provider_key_sources:
  acme: user
`,
			want: map[string]any{
				"name":                 "Custom Router",
				"enabled_models":       []any{"acme/qwen3-coder"},
				"provider_key_sources": map[string]any{"acme": "user"},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			manifestPath := filepath.Join(dir, "router.yml")
			if err := os.WriteFile(manifestPath, []byte(tc.manifest), 0o644); err != nil {
				t.Fatalf("write manifest: %v", err)
			}

			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog" {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"groups":[]}`))
					return
				}
				raw, _ := io.ReadAll(r.Body)
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatalf("decode body: %v", err)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_new"})
			}))
			defer srv.Close()
			useTestAPIKey(t)

			cmd := newRootCmd("dev")
			cmd.SetArgs([]string{"--api-url", srv.URL, "router", "create", "--from-file", manifestPath})
			if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
				t.Fatalf("dari router create --from-file: %v", err)
			}
			if !reflect.DeepEqual(body, tc.want) {
				t.Fatalf("create body = %#v, want %#v", body, tc.want)
			}
		})
	}
}

func TestRouterCreateFromFileRejectsConfigFlags(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "router.yml")
	if err := os.WriteFile(manifestPath, []byte(`name: Conflict Router
enabled_models:
  - openai/gpt-5.5
`), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"router", "create", "--from-file", manifestPath, "--model", "openai/gpt-5.5"})
	cmd.SetErr(io.Discard)
	err := captureStdout(t, func() error { return cmd.Execute() })
	if err == nil || !strings.Contains(err.Error(), "cannot be combined with router config flags") {
		t.Fatalf("error = %v, want --from-file conflict", err)
	}
}

func TestRouterCreateRequiresModels(t *testing.T) {
	useTestAPIKey(t)
	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"router", "create", "NoModels"})
	cmd.SetErr(io.Discard)
	err := captureStdout(t, func() error { return cmd.Execute() })
	if err == nil || !strings.Contains(err.Error(), "at least one --model is required") {
		t.Fatalf("error = %v, want missing --model", err)
	}
}

func TestRouterUpdateOverlaysCurrentConfig(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/organizations/current/routers/rtr_123":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "rtr_123",
				"name":           "Production",
				"enabled_models": []string{"fireworks/deepseek-ai/DeepSeek-V4-Pro"},
			})
		case "PUT /v1/organizations/current/routers/rtr_123":
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_123"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"--api-url", srv.URL, "router", "update", "rtr_123",
		"--name", "Staging",
		"--managed-key", "fireworks",
		"--allow-long-context=false",
		"--eval-score-imputation=false",
		"--session-pinning",
		"--native-compaction=false",
	})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router update: %v", err)
	}

	want := map[string]any{
		"name":                  "Staging",
		"enabled_models":        []any{"fireworks/deepseek-ai/DeepSeek-V4-Pro"},
		"provider_key_sources":  map[string]any{"fireworks": "managed"},
		"allow_long_context":    false,
		"eval_score_imputation": false,
		"session_pinning":       true,
		"native_compaction":     false,
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("update body = %#v, want %#v", body, want)
	}
}

func TestRouterUpdateKeepsCustomStrategy(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/organizations/current/routers/rtr_123":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":               "rtr_123",
				"name":             "Production",
				"enabled_models":   []string{"fireworks/deepseek-ai/DeepSeek-V4-Pro"},
				"routing_strategy": "custom",
				"custom_config": map[string]any{
					"rules":   []map[string]any{{"when": "tools", "use": "fireworks/deepseek-ai/DeepSeek-V4-Pro"}},
					"default": "fireworks/deepseek-ai/DeepSeek-V4-Pro",
				},
			})
		case "PUT /v1/organizations/current/routers/rtr_123":
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_123"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "update", "rtr_123", "--name", "Staging"})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router update: %v", err)
	}

	want := map[string]any{
		"name":           "Staging",
		"enabled_models": []any{"fireworks/deepseek-ai/DeepSeek-V4-Pro"},
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("update body = %#v, want %#v", body, want)
	}
}

func TestRouterUpdateRejectsSwitchToCustomViaFlag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/organizations/current/routers/rtr_123":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "rtr_123",
				"name":           "Production",
				"enabled_models": []string{"fireworks/deepseek-ai/DeepSeek-V4-Pro"},
			})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "update", "rtr_123", "--strategy", "custom"})
	cmd.SetErr(io.Discard)
	err := captureStdout(t, func() error { return cmd.Execute() })
	if err == nil {
		t.Fatal("expected error for --strategy custom on a non-custom router")
	}
	if !strings.Contains(err.Error(), "custom_config") {
		t.Fatalf("error = %q, want manifest guidance", err)
	}
}

func TestRouterCreateRejectsCustomStrategyFlag(t *testing.T) {
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"--api-url", "http://127.0.0.1:1", "router", "create", "Production",
		"--model", "fireworks/deepseek-ai/DeepSeek-V4-Pro",
		"--strategy", "custom",
	})
	cmd.SetErr(io.Discard)
	err := captureStdout(t, func() error { return cmd.Execute() })
	if err == nil {
		t.Fatal("expected error for --strategy custom on flag-based create")
	}
	if !strings.Contains(err.Error(), "--from-file") {
		t.Fatalf("error = %q, want --from-file guidance", err)
	}
}

func TestRouterDeleteSkipsConfirmWithYes(t *testing.T) {
	seen := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		seen[r.Method+" "+r.URL.Path] = true
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_123", "deleted_at": "2026-06-12T00:00:00Z"})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "delete", "https://routing.dari.dev/rtr_123/chat/completions", "--yes"})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router delete: %v", err)
	}
	if !seen["DELETE /v1/organizations/current/routers/rtr_123"] {
		t.Fatalf("did not see delete request; saw %v", seen)
	}
}

func TestEvalCommandsUseAPIKeyRoutes(t *testing.T) {
	seen := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		seen[r.Method+" "+r.URL.Path] = true
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/organizations/current/evals":
			if models := r.URL.Query()["model"]; len(models) > 0 {
				seen["models "+strings.Join(models, " ")] = true
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"evals": []any{map[string]any{"id": "eval_123"}}})
		case "/v1/organizations/current/evals/eval_123":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "eval_123", "name": "Code quality"})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	useTestAPIKey(t)

	for _, args := range [][]string{
		{"--api-url", srv.URL, "eval", "list"},
		{"--api-url", srv.URL, "eval", "list", "--model", "anthropic/claude-fable-5:medium,high", "--model", "openai/gpt-5.6-sol"},
		{"--api-url", srv.URL, "eval", "get", "eval_123"},
	} {
		cmd := newRootCmd("dev")
		cmd.SetArgs(args)
		if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
			t.Fatalf("dari %v: %v", args, err)
		}
	}

	for _, want := range []string{
		"GET /v1/organizations/current/evals",
		"models anthropic/claude-fable-5:medium,high openai/gpt-5.6-sol",
		"GET /v1/organizations/current/evals/eval_123",
	} {
		if !seen[want] {
			t.Fatalf("did not see request %s", want)
		}
	}
}
