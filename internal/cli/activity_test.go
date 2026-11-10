package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/state"
)

func TestConversationGetFiltersAgentLoop(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("request_class") != "workflow" || r.URL.Query().Get("agent_id") != "agent-a" {
			t.Errorf("unexpected filters: %v", r.URL.Query())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"steps":[]}`))
	}))
	defer srv.Close()
	useTestAPIKey(t)
	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "activity", "conversations", "get", "rreq_example", "--request-class", "workflow", "--agent-id", "agent-a"})
	if _, err := captureStdoutBytes(t, cmd.Execute); err != nil {
		t.Fatal(err)
	}
}

func TestActivityModelsUsesAuthenticatedCurrentOrgRouteAndPreservesFilters(t *testing.T) {
	var gotQuery map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/v1/organizations/current/routing/activity/models" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		gotQuery = r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"from_at": "2026-07-01T00:00:00Z",
			"to_at":   "2026-07-08T00:00:00Z",
			"summary": map[string]any{
				"model_steps":                4,
				"switched_conversation_rate": 0.5,
			},
			"models": []map[string]any{{
				"model":                      "openai/gpt-5.5",
				"provider_cost_per_step_usd": "0.0025",
				"non_completion_rate":        0.25,
			}},
			"transitions": []map[string]any{{"switch_share": 1.0}},
		})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"--api-url", srv.URL,
		"activity", "models",
		"--from", "2026-07-01T00:00:00Z",
		"--to", "2026-07-08T00:00:00Z",
		"--router-id", "rtr_123",
		"--api-key-id", "oak_1",
		"--api-key-id", "oak_2",
		"--user-id", "usr_123",
		"--model", "openai/gpt-5.5",
		"--model", "anthropic/claude-opus-4-6",
		"--provider", "openai",
		"--status", "provider_error",
	})

	output, err := captureStdoutBytes(t, cmd.Execute)
	if err != nil {
		t.Fatal(err)
	}
	wantQuery := map[string][]string{
		"from":       {"2026-07-01T00:00:00Z"},
		"to":         {"2026-07-08T00:00:00Z"},
		"router_id":  {"rtr_123"},
		"api_key_id": {"oak_1", "oak_2"},
		"user_id":    {"usr_123"},
		"model":      {"openai/gpt-5.5", "anthropic/claude-opus-4-6"},
		"provider":   {"openai"},
		"status":     {"provider_error"},
	}
	if !reflect.DeepEqual(gotQuery, wantQuery) {
		t.Fatalf("query = %#v, want %#v", gotQuery, wantQuery)
	}

	var payload map[string]any
	if err := json.Unmarshal(output, &payload); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, output)
	}
	models := payload["models"].([]any)
	model := models[0].(map[string]any)
	if model["provider_cost_per_step_usd"] != "0.0025" {
		t.Fatalf("provider_cost_per_step_usd = %#v", model["provider_cost_per_step_usd"])
	}
}

func TestActivityCommandsExposeActivityAPIRoutes(t *testing.T) {
	useTestAPIKey(t)
	tests := []struct {
		name      string
		args      []string
		wantPath  string
		wantQuery map[string]string
	}{
		{
			name:      "filters",
			args:      []string{"activity", "filter-options", "--from", "2026-07-01T00:00:00Z", "--to", "2026-07-08T00:00:00Z"},
			wantPath:  "/v1/organizations/current/routing/activity/filter-options",
			wantQuery: map[string]string{"from": "2026-07-01T00:00:00Z"},
		},
		{
			name:      "overview",
			args:      []string{"activity", "overview", "--from", "2026-07-01T00:00:00Z", "--to", "2026-07-01T01:00:00Z", "--bucket-seconds", "300"},
			wantPath:  "/v1/organizations/current/routing/activity/overview",
			wantQuery: map[string]string{"bucket_seconds": "300"},
		},
		{
			name:      "people",
			args:      []string{"activity", "people", "--from", "2026-07-01T00:00:00Z", "--to", "2026-07-08T00:00:00Z", "--scope", "keys", "--search", "prod", "--limit", "10"},
			wantPath:  "/v1/organizations/current/routing/activity/people-keys",
			wantQuery: map[string]string{"identity_scope": "keys", "search": "prod", "limit": "10"},
		},
		{
			name:      "conversations",
			args:      []string{"activity", "conversations", "--from", "2026-07-01T00:00:00Z", "--to", "2026-07-08T00:00:00Z", "--sort-by", "spend"},
			wantPath:  "/v1/organizations/current/routing/activity/conversations",
			wantQuery: map[string]string{"sort_by": "spend"},
		},
		{
			name:      "conversation detail",
			args:      []string{"activity", "conversations", "get", "conv/a", "--limit", "25"},
			wantPath:  "/v1/organizations/current/routing/activity/conversations/conv%2Fa",
			wantQuery: map[string]string{"limit": "25"},
		},
		{
			name:      "people series",
			args:      []string{"activity", "people", "series", "--from", "2026-07-01T00:00:00Z", "--to", "2026-07-08T00:00:00Z", "--comparison-user-id", "usr_a", "--comparison-user-id", "usr_b"},
			wantPath:  "/v1/organizations/current/routing/activity/people-series",
			wantQuery: map[string]string{"comparison_user_id": "usr_a", "bucket_seconds": "86400"},
		},
		{
			name:      "tools inventory",
			args:      []string{"activity", "tools", "list", "--from", "2026-07-01T00:00:00Z", "--to", "2026-07-08T00:00:00Z", "--sort-by", "latest"},
			wantPath:  "/v1/organizations/current/routing/activity/tools-skills/inventory",
			wantQuery: map[string]string{"mode": "tools", "sort_by": "latest"},
		},
		{
			name:      "skill detail",
			args:      []string{"activity", "skills", "get", "dari", "--from", "2026-07-01T00:00:00Z", "--to", "2026-07-08T00:00:00Z"},
			wantPath:  "/v1/organizations/current/routing/activity/tools-skills/detail",
			wantQuery: map[string]string{"mode": "skills", "capability_id": "dari"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.EscapedPath() != test.wantPath {
					t.Fatalf("path = %s, want %s", r.URL.EscapedPath(), test.wantPath)
				}
				for key, want := range test.wantQuery {
					if got := r.URL.Query().Get(key); got != want {
						t.Fatalf("query %s = %q, want %q", key, got, want)
					}
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{}`)
			}))
			defer srv.Close()

			cmd := newRootCmd("dev")
			cmd.SetArgs(append([]string{"--api-url", srv.URL}, test.args...))
			if err := captureStdout(t, cmd.Execute); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestActivityModelsExplicitOrganizationUsesBrowserSession(t *testing.T) {
	t.Setenv("DARI_API_KEY", "")
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	expiresAt := time.Now().Add(time.Hour).Unix()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/organizations/org_customer/routing/activity/models" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer user-jwt" {
			t.Fatalf("Authorization = %q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"summary":     map[string]any{"model_steps": 0},
			"models":      []any{},
			"transitions": []any{},
		})
	}))
	defer srv.Close()

	if err := state.Save(&state.CliState{
		APIURL: srv.URL,
		SupabaseSession: &state.SupabaseSession{
			AccessToken:  "user-jwt",
			RefreshToken: "refresh-token",
			ExpiresAt:    &expiresAt,
		},
		Organizations: map[string]state.Organization{},
	}); err != nil {
		t.Fatal(err)
	}

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"--api-url", srv.URL,
		"activity", "models",
		"--organization-id", "org_customer",
		"--from", "2026-07-01T00:00:00Z",
		"--to", "2026-07-08T00:00:00Z",
	})
	if err := captureStdout(t, cmd.Execute); err != nil {
		t.Fatal(err)
	}
}

func TestActivityModelsExplicitOrganizationRejectsManagementKey(t *testing.T) {
	useTestAPIKey(t)
	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"activity", "models",
		"--organization-id", "org_customer",
		"--from", "2026-07-01T00:00:00Z",
		"--to", "2026-07-08T00:00:00Z",
	})
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "requires browser login") {
		t.Fatalf("error = %v", err)
	}
}

func TestActivityModelsRejectsInvalidRangeAndStatusBeforeRequest(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "invalid timestamp",
			args: []string{"activity", "models", "--from", "yesterday", "--to", "2026-07-08T00:00:00Z"},
			want: "invalid --from",
		},
		{
			name: "reversed range",
			args: []string{"activity", "models", "--from", "2026-07-08T00:00:00Z", "--to", "2026-07-01T00:00:00Z"},
			want: "--to must be later",
		},
		{
			name: "invalid status",
			args: []string{"activity", "models", "--from", "2026-07-01T00:00:00Z", "--to", "2026-07-08T00:00:00Z", "--status", "failed"},
			want: "invalid --status",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cmd := newRootCmd("dev")
			cmd.SetArgs(test.args)
			err := cmd.Execute()
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestActivityBucketDefaultsFollowRange(t *testing.T) {
	tests := []struct {
		name string
		from string
		to   string
		want int
	}{
		{"hour", "2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z", 60},
		{"day", "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z", 900},
		{"week", "2026-07-01T00:00:00Z", "2026-07-08T00:00:00Z", 86400},
		{"year-range", "2026-01-01T00:00:00Z", "2026-12-01T00:00:00Z", 2592000},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			from := mustParseActivityTime(t, test.from)
			to := mustParseActivityTime(t, test.to)
			if got := defaultActivityBucketSeconds(from, to); got != test.want {
				t.Fatalf("defaultActivityBucketSeconds = %d, want %d", got, test.want)
			}
		})
	}
}

func TestActivityBucketLimitRejectsPartialExtraBucket(t *testing.T) {
	from := mustParseActivityTime(t, "2026-07-01T00:00:00Z")
	to := from.Add(1000*300*time.Second + time.Second)
	if !tooManyActivityBuckets(from, to, 300) {
		t.Fatal("expected more than 1000 buckets to be rejected")
	}
	if tooManyActivityBuckets(from, from.Add(1000*300*time.Second), 300) {
		t.Fatal("expected exactly 1000 buckets to be allowed")
	}
}

func TestActivityRangeLimit(t *testing.T) {
	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"activity", "overview",
		"--from", "2025-01-01T00:00:00Z",
		"--to", "2026-07-08T00:00:00Z",
	})
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "cannot exceed 366 days") {
		t.Fatalf("error = %v", err)
	}
}

func TestActivityInvalidBucketRejected(t *testing.T) {
	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"activity", "overview",
		"--from", "2026-07-01T00:00:00Z",
		"--to", "2026-07-08T00:00:00Z",
		"--bucket-seconds", "3600",
	})
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "invalid --bucket-seconds") {
		t.Fatalf("error = %v", err)
	}
}

func mustParseActivityTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestActivityModelsAcceptsFractionalSecondTimestamps(t *testing.T) {
	flags := activityModelsFlags{
		from: "2026-07-01T00:00:00.000Z",
		to:   "2026-07-08T12:30:45.123456789+02:00",
	}
	query, err := flags.query()
	if err != nil {
		t.Fatal(err)
	}
	if got := query.Get("from"); got != "2026-07-01T00:00:00Z" {
		t.Fatalf("from = %q", got)
	}
	if got := query.Get("to"); got != "2026-07-08T12:30:45.123456789+02:00" {
		t.Fatalf("to = %q", got)
	}
}

func captureStdoutBytes(t *testing.T, run func() error) ([]byte, error) {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	defer func() { os.Stdout = old }()

	runErr := run()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	return output, runErr
}
