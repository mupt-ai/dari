package agents

import (
	"net/http"
	"testing"
)

func TestStatusFromHeaders(t *testing.T) {
	for _, tc := range []struct{ remaining, thinking, want string }{
		{"0", "off", "test/model · lease 1 turn left"},
		{"1", "high", "test/model · high · lease 2 turns left"},
		{"", "", "test/model"},
		{"bad", "high", "test/model · high"},
		{"-1", "off", "test/model"},
		{"1000000", "off", "test/model"},
	} {
		headers := http.Header{}
		headers.Set("x-dari-selected-model", "test/model")
		headers.Set("x-dari-thinking-level", tc.thinking)
		headers.Set("x-dari-lease-turns-remaining", tc.remaining)
		if got := StatusFromHeaders(headers).String(); got != tc.want {
			t.Errorf("%+v: got %q", tc, got)
		}
	}
	if got := (Status{Thinking: "high"}).String(); got != "" {
		t.Fatal(got)
	}
	if got := (Status{Model: "test\n/model\x1b‮"}).String(); got != "test/model" {
		t.Fatal(got)
	}
}

func TestStatusSessionPinned(t *testing.T) {
	headers := http.Header{}
	headers.Set("x-dari-selected-model", "anthropic/claude-opus-5-5")
	headers.Set("x-dari-thinking-level", "high")
	headers.Set("x-dari-session-pinned", "true")
	headers.Set("x-request-id", "req_1")
	status := StatusFromHeaders(headers)
	if !status.Pinned {
		t.Fatal("pinned header not read")
	}
	if got := status.String(); got != "anthropic/claude-opus-5-5 · high · pinned · https://app.dari.dev/activity/conversations/req_1" {
		t.Fatal(got)
	}
	// Pinning replaces the lease part even if a lease count is present.
	headers.Set("x-dari-lease-turns-remaining", "3")
	if got := StatusFromHeaders(headers).String(); got != "anthropic/claude-opus-5-5 · high · pinned · https://app.dari.dev/activity/conversations/req_1" {
		t.Fatal(got)
	}
}

// Only requests through hosted Dari reach the Activity dashboard, so only
// they get a link.
func TestStatusDashboardLink(t *testing.T) {
	headers := http.Header{}
	headers.Set("x-dari-selected-model", "m")
	headers.Set("x-request-id", "req/1")
	t.Setenv(NoActivityLinkEnv, "")
	t.Setenv(GatewayURLEnv, "")
	if got := StatusFromHeaders(headers).String(); got != "m · https://app.dari.dev/activity/conversations/req%2F1" {
		t.Fatal(got)
	}
	for _, gateway := range []struct{ env, value string }{
		{NoActivityLinkEnv, "1"},                 // a local or self-hosted gateway launch
		{GatewayURLEnv, "http://127.0.0.1:8787"}, // launches before NoActivityLinkEnv
	} {
		t.Run(gateway.env, func(t *testing.T) {
			t.Setenv(gateway.env, gateway.value)
			if got := StatusFromHeaders(headers).String(); got != "m" {
				t.Fatal(got)
			}
		})
	}
}

// A launch starts on the user's saved pick while the router offers it.
func TestDefaultStartsOnTheSavedPick(t *testing.T) {
	models := Models{Enabled: []string{"a/one", "a/two"}, Unavailable: []string{"b/three"}}
	for saved, want := range map[string]string{
		"":                 "dari/model/a/one",
		"dari/model/a/two": "dari/model/a/two",
		"dari/model/gone":  "dari/model/a/one",
		// A chosen model nothing can serve yet is not started on.
		"dari/model/b/three": "dari/model/a/one",
		"dari/routing":       "dari/model/a/one",
	} {
		models.Saved = saved
		if got := models.Default(); got != want {
			t.Errorf("Saved %q: Default() = %q, want %q", saved, got, want)
		}
	}
	routed := Models{Routing: true, Enabled: []string{"a/one"}, Saved: "dari/model/a/one"}
	if got := routed.Default(); got != "dari/model/a/one" {
		t.Errorf("with routing, Default() = %q", got)
	}
}
