package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
				"routing_strategy":     "dari",
			}
			if !reflect.DeepEqual(body, want) {
				t.Fatalf("create body = %#v, want %#v", body, want)
			}
		})
	}
}

func TestRouterCreateSendsEvalScoreImputationOnlyWhenSet(t *testing.T) {
	flagArgs := []string{"router", "create", "Flag Router", "--model", "openai/gpt-5.5", "--managed-key", "openai"}
	tests := []struct {
		name string
		args []string
		want any // nil means the field is omitted so the API default (on) applies
	}{
		{name: "flag omitted", args: flagArgs},
		{name: "flag false", args: append(slices.Clone(flagArgs), "--eval-score-imputation=false"), want: false},
		{name: "flag true", args: append(slices.Clone(flagArgs), "--eval-score-imputation"), want: true},
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
	tests := []struct {
		name string
		args []string
		want any // nil means the field is omitted
	}{
		{name: "flag omitted", args: []string{"router", "create", "Flag Router", "--model", "openai/gpt-5.5", "--managed-key", "openai"}},
		{name: "flag set", args: []string{"router", "create", "Flag Router", "--model", "openai/gpt-5.5", "--managed-key", "openai", "--session-pinning", "--native-compaction"}, want: true},
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
					"rules": []map[string]any{{"when": "tools", "use": "fireworks/deepseek-ai/DeepSeek-V4-Pro"}},
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

func TestRouterRoleModelFlags(t *testing.T) {
	current := map[string]any{
		"id":             "rtr_123",
		"name":           "Production",
		"enabled_models": []string{"anthropic/claude-fable-5-2", "deepseek-ai/DeepSeek-V4.1-Flash-1017"},
		"role_models":    map[string]any{"main": "anthropic/claude-fable-5-2", "subagent": nil},
	}
	for _, tc := range []struct {
		name string
		args []string
		want any
	}{
		{
			name: "create pins both roles",
			args: []string{"create", "Production", "--model", "anthropic/claude-fable-5-2,deepseek-ai/DeepSeek-V4.1-Flash-1017", "--main-model", "anthropic/claude-fable-5-2", "--subagent-model", "deepseek-ai/DeepSeek-V4.1-Flash-1017"},
			want: map[string]any{"main": "anthropic/claude-fable-5-2", "subagent": "deepseek-ai/DeepSeek-V4.1-Flash-1017"},
		},
		{
			name: "update one role keeps the other",
			args: []string{"update", "rtr_123", "--subagent-model", "deepseek-ai/DeepSeek-V4.1-Flash-1017"},
			want: map[string]any{"main": "anthropic/claude-fable-5-2", "subagent": "deepseek-ai/DeepSeek-V4.1-Flash-1017"},
		},
		{
			name: "update empty value routes the role again",
			args: []string{"update", "rtr_123", "--main-model", ""},
			want: map[string]any{"main": nil, "subagent": nil},
		},
		{
			name: "update without role flags leaves roles unchanged",
			args: []string{"update", "rtr_123", "--name", "Staging"},
			want: nil,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodGet {
					_ = json.NewEncoder(w).Encode(current)
					return
				}
				raw, _ := io.ReadAll(r.Body)
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatalf("decode body: %v", err)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_123"})
			}))
			defer srv.Close()
			useTestAPIKey(t)

			cmd := newRootCmd("dev")
			cmd.SetArgs(append([]string{"--api-url", srv.URL, "router"}, tc.args...))
			if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
				t.Fatalf("dari router %v: %v", tc.args, err)
			}
			if got := body["role_models"]; !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("role_models = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestRouterRolePromptFlags(t *testing.T) {
	current := map[string]any{
		"id":             "rtr_123",
		"name":           "Production",
		"enabled_models": []string{"anthropic/claude-fable-5-2"},
		"role_prompts":   map[string]any{"main": "Delegate exploration to subagents.", "subagent": nil},
	}
	for _, tc := range []struct {
		name string
		args []string
		want any
	}{
		{
			name: "create sets the main prompt",
			args: []string{"create", "Production", "--model", "anthropic/claude-fable-5-2", "--main-prompt", " Delegate exploration to subagents. "},
			want: map[string]any{"main": "Delegate exploration to subagents.", "subagent": nil},
		},
		{
			name: "update one role keeps the other",
			args: []string{"update", "rtr_123", "--subagent-prompt", "Report back briefly."},
			want: map[string]any{"main": "Delegate exploration to subagents.", "subagent": "Report back briefly."},
		},
		{
			name: "update empty value removes the prompt",
			args: []string{"update", "rtr_123", "--main-prompt", ""},
			want: map[string]any{"main": nil, "subagent": nil},
		},
		{
			name: "update without prompt flags leaves prompts unchanged",
			args: []string{"update", "rtr_123", "--name", "Staging"},
			want: nil,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodGet {
					_ = json.NewEncoder(w).Encode(current)
					return
				}
				raw, _ := io.ReadAll(r.Body)
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatalf("decode body: %v", err)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_123"})
			}))
			defer srv.Close()
			useTestAPIKey(t)

			cmd := newRootCmd("dev")
			cmd.SetArgs(append([]string{"--api-url", srv.URL, "router"}, tc.args...))
			if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
				t.Fatalf("dari router %v: %v", tc.args, err)
			}
			if got := body["role_prompts"]; !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("role_prompts = %#v, want %#v", got, tc.want)
			}
		})
	}
}
