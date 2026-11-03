package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
)

// launchWithRouters runs agent setup against a server listing routers and
// returns the chosen router and every other request it made.
func launchWithRouters(t *testing.T, agent string, routers []map[string]any) (string, []string) {
	t.Helper()
	var requests []string
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": routers})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})
		default:
			requests = append(requests, r.Method+" "+r.URL.Path)
			_ = json.NewEncoder(w).Encode(map[string]any{})
		}
	}))
	defer server.Close()
	useTestAPIKey(t)
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	routerID, err := ensureAgentRouter(
		context.Background(),
		agent,
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader(""),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	return routerID, requests
}

func TestAgentLaunchUsesTheRouterItIsAssigned(t *testing.T) {
	for _, agent := range []string{"claude", "pi"} {
		t.Run(agent, func(t *testing.T) {
			routerID, requests := launchWithRouters(t, agent, []map[string]any{
				{"id": "rtr_default", "is_default": true, "enabled_models": []string{"openai/gpt-5.6-sol"}},
				{"id": "rtr_own", "client_key": ownRouterKey("claude", true)},
				{"id": "rtr_fast", "coding_agents": []string{agentSetups[agent].codingAgent}},
			})
			if routerID != "rtr_fast" || len(requests) != 0 {
				t.Fatalf("router = %q, requests = %v", routerID, requests)
			}
		})
	}
}

func TestAgentMovedToDefaultRouterStaysThere(t *testing.T) {
	routerID, requests := launchWithRouters(t, "claude", []map[string]any{
		{"id": "rtr_default", "is_default": true, "coding_agents": []string{"claude_code"}},
		{"id": "rtr_own", "client_key": ownRouterKey("claude", false)},
	})
	if routerID != "rtr_default" || len(requests) != 0 {
		t.Fatalf("router = %q, requests = %v", routerID, requests)
	}
}

func TestReusedOwnRouterBecomesTheAgentsRouter(t *testing.T) {
	routerID, requests := launchWithRouters(t, "claude", []map[string]any{
		{"id": "rtr_default", "is_default": true},
		{"id": "rtr_managed", "client_key": ownRouterKey("claude", false)},
	})
	want := []string{"PUT /v1/organizations/current/routers/rtr_managed/coding-agents/claude_code"}
	if routerID != "rtr_managed" || !slices.Equal(requests, want) {
		t.Fatalf("router = %q, requests = %v", routerID, requests)
	}
}

func TestRouterAssignAgentCommand(t *testing.T) {
	var requested string
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = r.Method + " " + r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_123", "coding_agents": []string{"codex"}})
	}))
	defer server.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", server.URL, "router", "assign-agent", "rtr_123", "codex"})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router assign-agent: %v", err)
	}
	if want := "PUT /v1/organizations/current/routers/rtr_123/coding-agents/codex"; requested != want {
		t.Fatalf("request = %q, want %q", requested, want)
	}

	cmd = newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", server.URL, "router", "assign-agent", "rtr_123", "cursor"})
	cmd.SetErr(io.Discard)
	err := captureStdout(t, func() error { return cmd.Execute() })
	if err == nil || !strings.Contains(err.Error(), "claude, codex, muse, opencode, pi") {
		t.Fatalf("unknown agent error = %v", err)
	}
}
