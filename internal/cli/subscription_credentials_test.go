package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func multipleSubscriptionsServer(t *testing.T, seen map[string]map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(multipleSubscriptionsHandler(t, seen))
}

func multipleSubscriptionsHandler(t *testing.T, seen map[string]map[string]any) http.HandlerFunc {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		seen[r.Method+" "+r.URL.Path] = body
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{
				map[string]any{
					"name": "OPENAI_CODEX_OAUTH_TOKEN_2", "credential_scope": "user", "oauth_provider": "openai_codex",
					"label": "Work Plus", "safe_metadata": map[string]any{"account_email": "second@example.test"},
					"created_at": "2026-10-02T00:00:00Z", "subscription_active": true,
				},
				map[string]any{
					"name": "OPENAI_CODEX_OAUTH_TOKEN", "credential_scope": "user", "oauth_provider": "openai_codex",
					"safe_metadata": map[string]any{"account_email": "first@example.test"}, "created_at": "2026-10-01T00:00:00Z",
					"unavailable_until": "2099-10-16T12:00:00Z", "unavailable_reason": "ChatGPT usage limit reached.",
				},
				map[string]any{
					"name": "OPENAI_CODEX_OAUTH_TOKEN_3", "credential_scope": "user", "oauth_provider": "openai_codex",
					"created_at": "2026-10-03T00:00:00Z",
				},
				map[string]any{
					"name": "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN", "credential_scope": "user",
					"oauth_provider": "anthropic_claude_code", "created_at": "2026-10-01T00:00:00Z", "subscription_active": true,
				},
				map[string]any{
					"name": "META_MUSE_OAUTH_TOKEN", "credential_scope": "user", "oauth_provider": "meta_muse",
					"created_at": "2026-10-04T00:00:00Z", "subscription_active": true,
				},
				map[string]any{"name": "OPENAI_API_KEY", "credential_scope": "organization"},
			}})
		case "POST /v1/organizations/current/credentials/OPENAI_CODEX_OAUTH_TOKEN/mark-available",
			"DELETE /v1/organizations/current/credentials/ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN",
			"PUT /v1/organizations/current/credentials/OPENAI_CODEX_OAUTH_TOKEN_2/auto-reset",
			"PUT /v1/organizations/current/credentials/ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN/label",
			"POST /v1/organizations/current/credentials/META_MUSE_OAUTH_TOKEN/mark-available",
			"DELETE /v1/organizations/current/credentials/META_MUSE_OAUTH_TOKEN",
			"PUT /v1/organizations/current/credentials/META_MUSE_OAUTH_TOKEN/label":
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "ok"})
		case "POST /v1/organizations/current/credentials/oauth/sessions":
			_ = json.NewEncoder(w).Encode(agentSubscriptionOAuthStart{
				SessionToken: "session", AuthorizationURL: "https://auth.openai.com/codex/device", UserCode: "ABCD-EFGH",
			})
		case "POST /v1/organizations/current/credentials/oauth/sessions/complete":
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "OPENAI_CODEX_OAUTH_TOKEN"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	})
}

func TestSubscriptionListShowsConnectionOrderWithActiveAndHeld(t *testing.T) {
	useTestAPIKey(t)
	srv := multipleSubscriptionsServer(t, map[string]map[string]any{})
	defer srv.Close()

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "credentials", "subscription", "list"})
	output, err := captureStdoutBytes(t, cmd.Execute)
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Subscriptions []struct {
			Name, Provider, Status string
			AccountEmail           *string `json:"account_email"`
		} `json:"subscriptions"`
	}
	if err := json.Unmarshal(output, &listed); err != nil {
		t.Fatalf("decode %s: %v", output, err)
	}
	var got []string
	for _, s := range listed.Subscriptions {
		got = append(got, s.Provider+" "+s.Name+" "+s.Status)
	}
	want := []string{
		"claude-code ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN active",
		"muse-code META_MUSE_OAUTH_TOKEN active",
		"codex OPENAI_CODEX_OAUTH_TOKEN held",
		"codex OPENAI_CODEX_OAUTH_TOKEN_2 active",
		"codex OPENAI_CODEX_OAUTH_TOKEN_3 standby",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("subscriptions =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if email := listed.Subscriptions[3].AccountEmail; email == nil || *email != "second@example.test" {
		t.Fatalf("account_email = %v", email)
	}
}

func TestSubscriptionCommandsNeedANameWhenSeveralAreConnected(t *testing.T) {
	useTestAPIKey(t)
	seen := map[string]map[string]any{}
	srv := multipleSubscriptionsServer(t, seen)
	defer srv.Close()

	ambiguous := newRootCmd("dev")
	ambiguous.SetArgs([]string{"--api-url", srv.URL, "credentials", "subscription", "mark-available", "codex"})
	err := captureStdout(t, ambiguous.Execute)
	if err == nil || !strings.Contains(err.Error(), "3 ChatGPT subscriptions are connected; pass one of: "+
		"OPENAI_CODEX_OAUTH_TOKEN, OPENAI_CODEX_OAUTH_TOKEN_2, OPENAI_CODEX_OAUTH_TOKEN_3") {
		t.Fatalf("err = %v", err)
	}

	for _, args := range [][]string{
		{"credentials", "subscription", "mark-available", "openai_codex_oauth_token"},
		// The only Claude Code subscription is found by its provider alias.
		{"credentials", "subscription", "disconnect", "claude-code"},
		{"credentials", "subscription", "mark-available", "muse-code"},
		{"credentials", "subscription", "rename", "muse-code", "Muse Max"},
		{"credentials", "subscription", "disconnect", "muse-code"},
	} {
		cmd := newRootCmd("dev")
		cmd.SetArgs(append([]string{"--api-url", srv.URL}, args...))
		if err := captureStdout(t, cmd.Execute); err != nil {
			t.Fatalf("dari %v: %v", args, err)
		}
	}
	for _, want := range []string{
		"POST /v1/organizations/current/credentials/OPENAI_CODEX_OAUTH_TOKEN/mark-available",
		"DELETE /v1/organizations/current/credentials/ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN",
		"POST /v1/organizations/current/credentials/META_MUSE_OAUTH_TOKEN/mark-available",
		"PUT /v1/organizations/current/credentials/META_MUSE_OAUTH_TOKEN/label",
		"DELETE /v1/organizations/current/credentials/META_MUSE_OAUTH_TOKEN",
	} {
		if _, ok := seen[want]; !ok {
			t.Fatalf("did not see request %s", want)
		}
	}
}

func TestSubscriptionConnectAddsAnotherOrReconnectsOne(t *testing.T) {
	useTestAPIKey(t)
	original := openAgentBrowser
	openAgentBrowser = func(string) bool { return false }
	t.Cleanup(func() { openAgentBrowser = original })

	for _, tc := range []struct {
		args []string
		want map[string]any
	}{
		{[]string{"codex"}, map[string]any{"provider": "openai_codex"}},
		{[]string{"muse-code"}, map[string]any{"provider": "meta_muse"}},
		{
			[]string{"muse-code", "--reconnect", "meta_muse_oauth_token"},
			map[string]any{"provider": "meta_muse", "credential_name": "META_MUSE_OAUTH_TOKEN"},
		},
		{
			[]string{"codex", "--reconnect", "openai_codex_oauth_token_2"},
			map[string]any{"provider": "openai_codex", "credential_name": "OPENAI_CODEX_OAUTH_TOKEN_2"},
		},
	} {
		seen := map[string]map[string]any{}
		srv := multipleSubscriptionsServer(t, seen)
		cmd := newRootCmd("dev")
		cmd.SetIn(strings.NewReader("\n"))
		cmd.SetErr(&strings.Builder{})
		cmd.SetArgs(append([]string{"--api-url", srv.URL, "credentials", "subscription", "connect"}, tc.args...))
		if err := captureStdout(t, cmd.Execute); err != nil {
			t.Fatalf("connect %v: %v", tc.args, err)
		}
		srv.Close()
		started := seen["POST /v1/organizations/current/credentials/oauth/sessions"]
		if len(started) != len(tc.want) {
			t.Fatalf("start body = %#v, want %#v", started, tc.want)
		}
		for key, value := range tc.want {
			if started[key] != value {
				t.Fatalf("start body = %#v, want %#v", started, tc.want)
			}
		}
		if _, ok := seen["POST /v1/organizations/current/credentials/oauth/sessions/complete"]; !ok {
			t.Fatalf("connect %v did not complete the session", tc.args)
		}
	}
}

func TestSubscriptionAutoResetSendsTheSetting(t *testing.T) {
	useTestAPIKey(t)
	seen := map[string]map[string]any{}
	srv := multipleSubscriptionsServer(t, seen)
	defer srv.Close()

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "credentials", "subscription", "auto-reset", "openai_codex_oauth_token_2", "on"})
	if err := captureStdout(t, cmd.Execute); err != nil {
		t.Fatal(err)
	}
	body := seen["PUT /v1/organizations/current/credentials/OPENAI_CODEX_OAUTH_TOKEN_2/auto-reset"]
	if body["enabled"] != true {
		t.Fatalf("auto-reset body = %#v", body)
	}

	invalid := newRootCmd("dev")
	invalid.SetArgs([]string{"--api-url", srv.URL, "credentials", "subscription", "auto-reset", "codex", "maybe"})
	if err := captureStdout(t, invalid.Execute); err == nil || !strings.Contains(err.Error(), "expected on or off") {
		t.Fatalf("err = %v", err)
	}
}

func TestSubscriptionRenameSendsTheLabel(t *testing.T) {
	useTestAPIKey(t)
	seen := map[string]map[string]any{}
	srv := multipleSubscriptionsServer(t, seen)
	defer srv.Close()

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "credentials", "subscription", "rename", "claude-code", " Work Max "})
	if err := captureStdout(t, cmd.Execute); err != nil {
		t.Fatal(err)
	}
	body := seen["PUT /v1/organizations/current/credentials/ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN/label"]
	if body["label"] != "Work Max" {
		t.Fatalf("rename body = %#v", body)
	}
}
