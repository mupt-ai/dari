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

func TestAgentAccountLinesListSubscriptionsInRoutingOrderThenKeys(t *testing.T) {
	label := "Work"
	resets := time.Now().Add(2 * time.Hour)
	lines := agentAccountLines(personalSubscriptions([]subscriptionCredential{
		{Name: "CLAUDE_2", OAuthProvider: claudeSubscription.id, CredentialScope: "user", CreatedAt: "2026-02", Label: &label},
		{Name: "CODEX", OAuthProvider: codexSubscription.id, CredentialScope: "user", CreatedAt: "2026-01", SubscriptionActive: true, SafeMetadata: map[string]string{"account_email": "me@example.test", "plan": "Plus"}},
		{Name: "CLAUDE", OAuthProvider: claudeSubscription.id, CredentialScope: "user", CreatedAt: "2026-01", Usage: &subscriptionUsage{Utilization: 0.4, ResetsAt: resets.Format(time.RFC3339)}},
		{Name: "TEAM", OAuthProvider: codexSubscription.id, CredentialScope: "organization"},
		{Name: "MUSE", OAuthProvider: museSubscription.id, CredentialScope: "user", CreatedAt: "2026-03"},
	}), []string{"Vercel AI Gateway"}, true)
	got := stripANSI(strings.Join(lines, "\n"))
	want := "\n  Subscriptions\n" +
		"  • Claude Code  CLAUDE\n" +
		"    › 5h · 40% used · Resets " + usageResetTime(resets) + "\n" +
		"  • Claude Code  Work\n" +
		"  • Muse Code  MUSE\n" +
		"  • ChatGPT  me@example.test  Plus\n" +
		"\n  API Keys\n" +
		"  • Vercel AI Gateway\n"
	if got != want {
		t.Fatalf("lines:\n%s\nwant:\n%s", got, want)
	}
	// Only sections with something to show appear.
	if keysOnly := stripANSI(strings.Join(agentAccountLines(nil, []string{"OpenAI"}, true), "\n")); strings.Contains(keysOnly, "Subscriptions") {
		t.Fatalf("keys only: %q", keysOnly)
	}
	if empty := stripANSI(strings.Join(agentAccountLines(nil, nil, false), "\n")); !strings.Contains(empty, "No accounts connected yet.") {
		t.Fatalf("empty list: %q", empty)
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

func TestSubscriptionDetailsNameUsageReportedWithoutWindows(t *testing.T) {
	resets := time.Now().Add(2 * time.Hour)
	got := subscriptionDetails(subscriptionCredential{Usage: &subscriptionUsage{Utilization: 0.62, ResetsAt: resets.Format(time.RFC3339)}})
	if want := []string{"5h · 62% used · Resets " + usageResetTime(resets)}; !slices.Equal(got, want) {
		t.Fatalf("details = %q, want %q", got, want)
	}
	expired := subscriptionDetails(subscriptionCredential{Usage: &subscriptionUsage{Utilization: 1, ResetsAt: time.Now().Add(-time.Minute).Format(time.RFC3339)}})
	if len(expired) != 0 {
		t.Fatalf("expired usage details = %q", expired)
	}
}

func TestSubscriptionDetailsShowEveryUsageWindow(t *testing.T) {
	fiveHours := time.Now().Add(2 * time.Hour)
	week := time.Now().Add(96 * time.Hour)
	usage := &subscriptionUsage{
		Utilization: 0.99,
		ResetsAt:    fiveHours.Format(time.RFC3339),
		Windows: []subscriptionUsageWindow{
			{Minutes: 300, Utilization: 0.99, ResetsAt: fiveHours.Format(time.RFC3339)},
			{Minutes: 10080, Utilization: 0.2, ResetsAt: week.Format(time.RFC3339)},
		},
	}
	got := subscriptionDetails(subscriptionCredential{Usage: usage})
	want := []string{"5h · 99% used · Resets " + usageResetTime(fiveHours), "Weekly · 20% used · Resets " + usageResetTime(week)}
	if !slices.Equal(got, want) {
		t.Fatalf("details = %q, want %q", got, want)
	}
	// Held until the five hour reset: that window is at its limit, and the
	// weekly window still shows its headroom.
	held := fiveHours.Format(time.RFC3339)
	got = subscriptionDetails(subscriptionCredential{Usage: usage, UnavailableUntil: &held})
	want = []string{"5h · Limit reached · Resets " + usageResetTime(fiveHours), "Weekly · 20% used · Resets " + usageResetTime(week)}
	if !slices.Equal(got, want) {
		t.Fatalf("held details = %q, want %q", got, want)
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

func TestSubscriptionDetailsNameAHoldWithoutUsage(t *testing.T) {
	soon := time.Now().Add(3 * time.Hour).Format(time.RFC3339)
	later := time.Now().Add(50 * time.Hour).Format(time.RFC3339)
	cases := []struct {
		provider, until, want string
	}{
		{"openai_codex", soon, "5h"},
		{"openai_codex", later, "Weekly"},
		// Muse Code plans have only the five hour window.
		{"meta_muse", later, "5h"},
	}
	for _, c := range cases {
		got := subscriptionDetails(subscriptionCredential{OAuthProvider: c.provider, UnavailableUntil: &c.until})
		if len(got) != 1 || !strings.HasPrefix(got[0], c.want+" · Limit reached · Resets ") {
			t.Fatalf("%s held until %s: details = %q", c.provider, c.until, got)
		}
	}
}
