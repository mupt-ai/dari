package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCurrentOrgCommandsUseAPIKeyRoutes(t *testing.T) {
	seen := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		seen[r.Method+" "+r.URL.Path] = true
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{map[string]any{
				"name": "OPENAI_CODEX_OAUTH_TOKEN", "credential_scope": "user", "oauth_provider": "openai_codex",
			}}})
		case "DELETE /v1/organizations/current/credentials/OPENAI_CODEX_OAUTH_TOKEN":
			if r.URL.RawQuery != "scope=user" {
				t.Fatalf("subscription disconnect query = %q", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "OPENAI_CODEX_OAUTH_TOKEN"})
		case "GET /v1/organizations/current/members":
			_ = json.NewEncoder(w).Encode(map[string]any{"members": []any{}})
		case "POST /v1/organizations/current/invitations":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "inv_123"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	useTestAPIKey(t)

	commands := [][]string{
		{"--api-url", srv.URL, "credentials", "list"},
		{"--api-url", srv.URL, "credentials", "subscription", "disconnect", "codex"},
		{"--api-url", srv.URL, "org", "members"},
		{"--api-url", srv.URL, "org", "invite", "new@example.test", "--role", "member"},
	}
	for _, args := range commands {
		cmd := newRootCmd("dev")
		cmd.SetArgs(args)
		if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
			t.Fatalf("dari %v: %v", args, err)
		}
	}

	for _, want := range []string{
		"GET /v1/organizations/current/credentials",
		"DELETE /v1/organizations/current/credentials/OPENAI_CODEX_OAUTH_TOKEN",
		"GET /v1/organizations/current/members",
		"POST /v1/organizations/current/invitations",
	} {
		if !seen[want] {
			t.Fatalf("did not see request %s", want)
		}
	}
}
