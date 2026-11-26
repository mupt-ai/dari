package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func routerSubscriptionTestServer(t *testing.T, body *map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/organizations/current/routers/rtr_123":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "rtr_123",
				"name":           "Production",
				"enabled_models": []string{"openai/gpt-5.6-sol", "anthropic/claude-fable-5"},
			})
		case "GET /v1/organizations/current/routers/model-catalog":
			_, _ = w.Write([]byte(`{"groups":[{"provider":"openai","models":[{"id":"openai/gpt-5.6-sol"}]},{"provider":"anthropic","models":[{"id":"anthropic/claude-fable-5"}]}]}`))
		case "POST /v1/organizations/current/routers", "PUT /v1/organizations/current/routers/rtr_123":
			raw, _ := io.ReadAll(r.Body)
			*body = nil
			if err := json.Unmarshal(raw, body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_123"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// Without --sources, models of a provider given a key run on its API and
// the rest on plans.
func TestRouterCreateDefaultsKeyedProvidersToAPI(t *testing.T) {
	var body map[string]any
	srv := routerSubscriptionTestServer(t, &body)
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"--api-url", srv.URL, "router", "create", "Keys",
		"--model", "openai/gpt-5.6-sol,anthropic/claude-fable-5",
		"--managed-key", "openai",
	})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router create: %v", err)
	}
	want := map[string]any{"openai/gpt-5.6-sol": []any{"managed"}, "anthropic/claude-fable-5": []any{"plan"}}
	if got := body["model_sources"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("model_sources = %#v, want %#v", got, want)
	}
}

func TestRouterUpdateSendsResetMinHours(t *testing.T) {
	var body map[string]any
	srv := routerSubscriptionTestServer(t, &body)
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "update", "rtr_123", "--reset-min-hours", "6"})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router update: %v", err)
	}
	if body["reset_min_hours"] != float64(6) {
		t.Fatalf("reset_min_hours = %#v", body["reset_min_hours"])
	}
	if _, sent := body["model_sources"]; sent {
		t.Fatalf("model_sources sent without --sources: %#v", body)
	}
}

func TestRouterCreateSendsModelSources(t *testing.T) {
	var body map[string]any
	srv := routerSubscriptionTestServer(t, &body)
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"--api-url", srv.URL, "router", "create", "Sources",
		"--model", "openai/gpt-5.6-sol,anthropic/claude-fable-5",
		"--sources", "openai/gpt-5.6-sol=plan,reset,key,managed", "--sources", "anthropic/claude-fable-5=Managed",
	})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router create: %v", err)
	}
	want := map[string]any{"openai/gpt-5.6-sol": []any{"plan", "reset", "key", "managed"}, "anthropic/claude-fable-5": []any{"managed"}}
	if got := body["model_sources"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("model_sources = %#v, want %#v", got, want)
	}
}

func TestRouterSourcesRejectsBadValues(t *testing.T) {
	for _, tc := range []struct{ args []string }{
		{[]string{"--sources", "anthropic/claude-fable-5=reset,plan"}},
		{[]string{"--sources", "anthropic/claude-fable-5=plan,key,reset"}},
		{[]string{"--reset-min-hours", "-1"}},
		{[]string{"--sources", "anthropic/claude-fable-5=plan,api"}},
		{[]string{"--sources", "anthropic/claude-fable-5=plan,plan"}},
	} {
		var body map[string]any
		srv := routerSubscriptionTestServer(t, &body)
		useTestAPIKey(t)
		cmd := newRootCmd("dev")
		cmd.SilenceUsage, cmd.SilenceErrors = true, true
		cmd.SetArgs(append([]string{"--api-url", srv.URL, "router", "update", "rtr_123"}, tc.args...))
		if err := cmd.Execute(); err == nil {
			t.Fatalf("%v: no error", tc.args)
		}
		if body != nil {
			t.Fatalf("%v: sent %#v", tc.args, body)
		}
	}
}

// withEmptyCatalog serves an empty model catalog ahead of handler, for
// `router create` runs that look up models' providers.
func withEmptyCatalog(handler http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog" {
			_, _ = w.Write([]byte(`{"groups":[]}`))
			return
		}
		handler(w, r)
	})
}
