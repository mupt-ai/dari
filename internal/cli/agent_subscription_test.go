package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/state"
)

func TestLoggedInAgentConnectsMissingSubscription(t *testing.T) {
	for _, tc := range []struct{ agent, provider, input string }{
		{"claude", "anthropic_claude_code", "y\ntest-code#test-state\n"},
		{"pi", "openai_codex", "y\n\n"},
		{"opencode", "openai_codex", "y\n\n"},
	} {
		t.Run(tc.agent+"/"+tc.provider, func(t *testing.T) {
			t.Setenv("DARI_CONFIG_DIR", t.TempDir())
			t.Setenv("DARI_API_KEY", "")
			t.Setenv(agents.RoutingAPIKeyEnv, "")
			var connected, updated bool
			server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer dari_org" {
					t.Errorf("unexpected auth")
				}
				switch r.Method + " " + r.URL.Path {
				case "GET /v1/organizations/current/routers":
					_ = json.NewEncoder(w).Encode(map[string]any{"routers": []agentRouter{
						{ID: "default", Name: "Default", IsDefault: true, EnabledModels: []string{"openai/test", "anthropic/test"}, ModelProviders: map[string]string{"openai/test": "openai", "anthropic/test": "anthropic"}},
						{ID: "claude", Name: "Claude", ClientKey: ownRouterKey("claude", true), CodingAgents: []string{"claude_code"}, EnabledModels: []string{"anthropic/test"}, ModelProviders: map[string]string{"anthropic/test": "anthropic"}},
					}})
				case "GET /v1/organizations/current/credentials":
					credentials := []agentCredential{}
					if connected {
						credentials = append(credentials, agentCredential{OAuthProvider: tc.provider})
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"credentials": credentials})
				case "POST /v1/organizations/current/credentials/oauth/sessions":
					var body map[string]string
					_ = json.NewDecoder(r.Body).Decode(&body)
					if body["provider"] != tc.provider {
						t.Errorf("provider = %s", body["provider"])
					}
					started := agentSubscriptionOAuthStart{SessionToken: "session", AuthorizationURL: "https://example.test/oauth"}
					if tc.provider == "openai_codex" {
						started.UserCode = "TEST-CODE"
					}
					_ = json.NewEncoder(w).Encode(started)
				case "POST /v1/organizations/current/credentials/oauth/sessions/complete":
					var body map[string]string
					_ = json.NewDecoder(r.Body).Decode(&body)
					validResponse := body["authorization_response"] == "test-code#test-state"
					if tc.provider == "openai_codex" {
						validResponse = body["authorization_response"] == ""
					}
					if body["session_token"] != "session" || !validResponse {
						t.Errorf("invalid completion: %#v", body)
					}
					connected = true
					w.WriteHeader(http.StatusOK)
				case "PUT /v1/organizations/current/routers/default", "PUT /v1/organizations/current/routers/claude":
					var body agentRouterSubscriptionUpdateRequest
					_ = json.NewDecoder(r.Body).Decode(&body)
					updated = slices.Contains(body.SubscriptionProviders, map[string]string{"openai_codex": "openai", "anthropic_claude_code": "anthropic"}[tc.provider])
					_ = json.NewEncoder(w).Encode(map[string]any{})
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			t.Setenv("DARI_API_URL", server.URL)
			if err := state.Save(&state.CliState{APIURL: server.URL, CurrentOrgID: "org", SupabaseSession: &state.SupabaseSession{UserID: "user"}, Organizations: map[string]state.Organization{"org": {ID: "org", APIKey: "dari_org"}}}); err != nil {
				t.Fatal(err)
			}
			scope := server.URL + "|org:org"
			if _, _, err := state.EnsureRoutingKey(scope, func() (string, error) { return "dari_route", nil }); err != nil {
				t.Fatal(err)
			}
			original := openAgentBrowser
			openAgentBrowser = func(string) bool { return false }
			t.Cleanup(func() { openAgentBrowser = original })
			var output strings.Builder
			access, err := resolveAgentRoutingAccess(context.Background(), strings.NewReader(""), &output)
			if err != nil {
				t.Fatal(err)
			}
			if access.key != "dari_route" {
				t.Fatalf("key = %s", access.key)
			}
			_, err = ensureAgentRouter(context.Background(), tc.agent, access, strings.NewReader(tc.input), &output)
			if err != nil {
				t.Fatal(err)
			}
			if !connected || !updated {
				t.Fatalf("connected=%v updated=%v output=%s", connected, updated, output.String())
			}
			if strings.Contains(output.String(), "Sign in to") {
				t.Fatal("asked already logged-in user to sign in")
			}
			output.Reset()
			_, err = ensureAgentRouter(context.Background(), tc.agent, access, strings.NewReader(""), &output)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(output.String(), "subscription?") || strings.Contains(output.String(), "Connect a subscription:") {
				t.Fatalf("prompted connected user: %s", output.String())
			}
		})
	}
}

func TestDefaultAgentSubscriptionDeclineAndEOF(t *testing.T) {
	for _, agent := range []string{"opencode", "pi"} {
		for _, answer := range []string{"", "decline"} {
			t.Run(agent+"/"+answer, func(t *testing.T) {
				useTestAPIKey(t)
				server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet || r.URL.Path != "/v1/organizations/current/credentials" {
						t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
						http.NotFound(w, r)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})
				}))
				defer server.Close()
				input := ""
				if answer == "decline" {
					input = "n\n"
				}
				_, err := ensureDefaultAgentSubscription(context.Background(), agent, api.New(server.URL), agentRouter{}, strings.NewReader(input), io.Discard)
				if err != nil {
					t.Fatal(err)
				}
				optedOut, err := agentSubscriptionOptedOut(context.Background(), api.New(server.URL), agent)
				if err != nil {
					t.Fatal(err)
				}
				if optedOut != (answer == "decline") {
					t.Fatalf("opted out = %v", optedOut)
				}
				var output strings.Builder
				_, err = ensureDefaultAgentSubscription(context.Background(), agent, api.New(server.URL), agentRouter{}, strings.NewReader(""), &output)
				if err != nil {
					t.Fatal(err)
				}
				if answer == "decline" && output.Len() != 0 {
					t.Fatalf("prompted after opt-out: %s", output.String())
				}
			})
		}
	}
}

func TestDefaultAgentSubscriptionDoesNotEnableRouterWhenAlreadyConnected(t *testing.T) {
	for _, tc := range []struct{ agent, provider string }{
		{"pi", "openai_codex"},
		{"opencode", "openai_codex"},
	} {
		t.Run(tc.agent+"/"+tc.provider, func(t *testing.T) {
			useTestAPIKey(t)
			var putRequests int
			server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.Method + " " + r.URL.Path {
				case "GET /v1/organizations/current/credentials":
					_ = json.NewEncoder(w).Encode(map[string]any{
						"credentials": []agentCredential{{OAuthProvider: tc.provider}},
					})
				default:
					if r.Method == http.MethodPut {
						putRequests++
					}
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			router := agentRouter{
				ID:            "default",
				Name:          "Dari Recommended Router",
				IsDefault:     true,
				EnabledModels: []string{"openai/test"},
			}
			_, err := ensureDefaultAgentSubscription(context.Background(), tc.agent, api.New(server.URL), router, strings.NewReader(""), io.Discard)
			if err != nil {
				t.Fatal(err)
			}
			if putRequests != 0 {
				t.Fatalf("PUT requests = %d, want 0", putRequests)
			}
		})
	}
}

func TestCodexDeviceCodeSubscriptionUsesCodeAndEmptyCompletion(t *testing.T) {
	useTestAPIKey(t)
	var completed map[string]any
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/organizations/current/credentials/oauth/sessions":
			_ = json.NewEncoder(w).Encode(agentSubscriptionOAuthStart{SessionToken: "session", AuthorizationURL: "https://auth.openai.com/codex/device", UserCode: "ABCD-EFGH"})
		case "POST /v1/organizations/current/credentials/oauth/sessions/complete":
			_ = json.NewDecoder(r.Body).Decode(&completed)
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	var output strings.Builder
	original := openAgentBrowser
	openAgentBrowser = func(string) bool { return false }
	t.Cleanup(func() { openAgentBrowser = original })
	err := connectAgentPersonalSubscription(context.Background(), codexSubscription, api.New(server.URL), strings.NewReader("\n"), &output, "")
	if err != nil {
		t.Fatal(err)
	}
	if completed["session_token"] != "session" || completed["authorization_response"] != "" {
		t.Fatalf("completion = %#v", completed)
	}
	for _, want := range []string{"ABCD-EFGH", "auth.openai.com/codex/device"} {
		if !strings.Contains(output.String(), want) {
			t.Errorf("output missing %q: %s", want, output.String())
		}
	}
}

func TestMuseCodeSubscriptionRetriesWhileMetaApprovalIsPending(t *testing.T) {
	useTestAPIKey(t)
	completions := 0
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/organizations/current/credentials/oauth/sessions":
			_ = json.NewEncoder(w).Encode(agentSubscriptionOAuthStart{SessionToken: "session", AuthorizationURL: "https://auth.meta.com/oauth/device/?code=BLXG-CHNZ", UserCode: "BLXG-CHNZ"})
		case "POST /v1/organizations/current/credentials/oauth/sessions/complete":
			completions++
			if completions == 1 {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{"detail": "Meta approval is still pending. Enter the code at Meta, finish approval, then try again."})
				return
			}
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	var output strings.Builder
	original := openAgentBrowser
	openAgentBrowser = func(string) bool { return false }
	t.Cleanup(func() { openAgentBrowser = original })
	err := connectAgentPersonalSubscription(context.Background(), museSubscription, api.New(server.URL), strings.NewReader("\n\n"), &output, "")
	if err != nil {
		t.Fatal(err)
	}
	if completions != 2 {
		t.Fatalf("completions = %d, want 2", completions)
	}
	for _, want := range []string{"Enter this code at Meta: BLXG-CHNZ", "Meta approval is still pending.", "Muse Code subscription connected"} {
		if !strings.Contains(output.String(), want) {
			t.Errorf("output missing %q: %s", want, output.String())
		}
	}
}

func TestAgentChoiceLinesNumberGroupedAccounts(t *testing.T) {
	resets := time.Now().Add(2 * time.Hour)
	claude := subscriptionCredential{Name: "CLAUDE", OAuthProvider: claudeSubscription.id, Usage: &subscriptionUsage{Windows: []subscriptionUsageWindow{{Label: "5 Hour", Utilization: 0.4, ResetsAt: resets.Format(time.RFC3339)}}}}
	lines := agentChoiceLines("Accounts", nil, []agentChoiceOption{
		{heading: "Subscriptions", label: subscriptionLabel(claude, true), details: subscriptionDetailLines(claude)},
		{heading: "API Keys", label: "Vercel AI Gateway"},
		{gap: true, label: "Done"},
		{label: "Add a subscription"},
	}, 2, "esc close")
	got := stripANSI(strings.Join(lines[1:], "\n"))
	want := "\n  Subscriptions\n" +
		"  1. Claude Code  CLAUDE\n" +
		"       › 5 Hour · 40% used · Resets " + usageResetTime(resets) + "\n" +
		"\n  API Keys\n" +
		"  2. Vercel AI Gateway\n" +
		"\n" +
		"❯ 3. Done\n" +
		"  4. Add a subscription\n" +
		"  ↑↓ move · enter confirm · esc close"
	if got != want {
		t.Fatalf("lines:\n%s\nwant:\n%s", got, want)
	}
}

func TestSubscriptionLinesMarkEveryLimitReached(t *testing.T) {
	resets := time.Now().Add(72 * time.Hour)
	lines := subscriptionLines(subscriptionCredential{
		OAuthProvider: claudeSubscription.id,
		SafeMetadata:  map[string]string{"account_email": "you@example.com", "plan": "Max"},
		ModelHolds:    []subscriptionModelHold{{Model: "anthropic/claude-fable-5", DisplayName: "Claude Fable 5", UnavailableUntil: resets.Format(time.RFC3339)}},
	}, false)
	if len(lines) != 2 || stripANSI(lines[0]) != "  • you@example.com  Max" {
		t.Fatalf("lines = %q", lines)
	}
	if !strings.Contains(lines[1], ansiRed+"Limit reached") {
		t.Fatalf("limit not highlighted: %q", lines[1])
	}
}

func TestAgentSubscriptionProvidersMatchTheAgent(t *testing.T) {
	for agent, want := range map[string][]agentSubscriptionProvider{
		"claude":   {claudeSubscription, codexSubscription},
		"codex":    {codexSubscription},
		"muse":     {museSubscription},
		"opencode": {codexSubscription},
		"pi":       {codexSubscription},
	} {
		if got := agentSubscriptionProviders(agent); !slices.Equal(got, want) {
			t.Errorf("%s: providers = %v, want %v", agent, got, want)
		}
	}
}

func TestSubscriptionDetailsShowPlanAndRenewal(t *testing.T) {
	renews := time.Now().Add(72 * time.Hour)
	got := subscriptionDetails(subscriptionCredential{SubscriptionActive: true, SafeMetadata: map[string]string{"plan": "Pro", "renews_at": renews.Format(time.RFC3339)}})
	want := []string{"Renews " + renews.Local().Format("Jan 2")}
	if !slices.Equal(got, want) {
		t.Fatalf("details = %q, want %q", got, want)
	}
	// A renewal date already past is a stale snapshot, not news.
	lapsed := subscriptionDetails(subscriptionCredential{SafeMetadata: map[string]string{"renews_at": "2026-01-05T00:00:00Z"}})
	if len(lapsed) != 0 {
		t.Fatalf("lapsed details = %q", lapsed)
	}
}

func TestSubscriptionDetailsShowEachModelAtItsLimit(t *testing.T) {
	resets := time.Now().Add(72 * time.Hour)
	got := subscriptionDetails(subscriptionCredential{ModelHolds: []subscriptionModelHold{
		{Model: "anthropic/claude-fable-5", DisplayName: "Claude Fable 5", UnavailableUntil: resets.Format(time.RFC3339), Reason: "Claude Code seven day fable usage limit reached."},
		// A server that sends no display name shows the id.
		{Model: "anthropic/claude-opus-5-5", UnavailableUntil: resets.Format(time.RFC3339)},
		{Model: "anthropic/claude-opus-5", UnavailableUntil: time.Now().Add(-time.Minute).Format(time.RFC3339)},
	}})
	want := []string{
		"Claude Fable 5 · Limit reached · Resets " + usageResetTime(resets),
		"anthropic/claude-opus-5-5 · Limit reached · Resets " + usageResetTime(resets),
	}
	if !slices.Equal(got, want) {
		t.Fatalf("details = %q, want %q", got, want)
	}
}

func TestSubscriptionDetailsShowEachWindowAsTheAPINamesIt(t *testing.T) {
	fiveHours := time.Now().Add(2 * time.Hour)
	week := time.Now().Add(96 * time.Hour)
	fableWeek := time.Now().Add(72 * time.Hour)
	usage := &subscriptionUsage{Windows: []subscriptionUsageWindow{
		{Label: "5 Hour", Minutes: 300, Utilization: 1, ResetsAt: fiveHours.Format(time.RFC3339)},
		{Label: "Weekly", Minutes: 10080, Utilization: 0.01, ResetsAt: week.Format(time.RFC3339)},
		{Label: "Claude Fable Weekly", ModelFamily: "fable", Minutes: 10080, Utilization: 0.02, ResetsAt: fableWeek.Format(time.RFC3339)},
		// A window that reset since the listing is gone.
		{Label: "Monthly", Minutes: 43200, Utilization: 0.5, ResetsAt: time.Now().Add(-time.Minute).Format(time.RFC3339)},
	}}
	got := subscriptionDetails(subscriptionCredential{Usage: usage})
	want := []string{
		"5 Hour · Limit reached · Resets " + usageResetTime(fiveHours),
		"Weekly · 1% used · Resets " + usageResetTime(week),
		"Claude Fable Weekly · 2% used · Resets " + usageResetTime(fableWeek),
	}
	if !slices.Equal(got, want) {
		t.Fatalf("details = %q, want %q", got, want)
	}
	// A full Fable window already names the Fable hold.
	usage.Windows[2].Utilization = 1
	got = subscriptionDetails(subscriptionCredential{Usage: usage, ModelHolds: []subscriptionModelHold{
		{Model: "anthropic/claude-fable-5", DisplayName: "Claude Fable 5", UnavailableUntil: fableWeek.Format(time.RFC3339)},
	}})
	if want := "Claude Fable Weekly · Limit reached · Resets " + usageResetTime(fableWeek); len(got) != 3 || got[2] != want {
		t.Fatalf("full Fable details = %q, want last %q", got, want)
	}
}
