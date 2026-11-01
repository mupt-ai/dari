package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/mupt-ai/dari-cli/internal/api"
)

func TestFreshMachineReusesConfiguredDefaultRouter(t *testing.T) {
	for _, agent := range []string{"claude", "pi", "codex", "opencode", "muse"} {
		t.Run(agent, func(t *testing.T) {
			useTestAPIKey(t)
			// Claude Code and Codex reuse their own managed router; the others
			// the default router.
			clientKey := ""
			if agentSetups[agent].ownsRouter() {
				clientKey = ownRouterKey(agent, false)
			}
			server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/organizations/current/routers":
					_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{{"id": "rtr_existing", "client_key": clientKey, "is_default": true, "enabled_models": []string{"openai/gpt-5.6-sol"}}}})
				case "/v1/organizations/current/credentials":
					_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}, "personal_subscriptions_allowed": true})
				case "/v1/auth/config":
					_ = json.NewEncoder(w).Encode(map[string]any{"personal_subscriptions_allowed": false})
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			t.Setenv("DARI_API_URL", server.URL)
			if err := saveAgentSubscriptionOptOut(context.Background(), api.New(server.URL), agent, true); err != nil {
				t.Fatal(err)
			}
			// No routing or onboarding cache is carried onto the second computer.
			t.Setenv("DARI_CONFIG_DIR", t.TempDir())
			var output strings.Builder
			id, err := ensureAgentRouter(context.Background(), agent, agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"}, strings.NewReader(""), &output)
			if err != nil {
				t.Fatal(err)
			}
			if id != "rtr_existing" {
				t.Fatalf("router = %q", id)
			}
			if output.Len() != 0 {
				t.Fatalf("unexpected setup: %s", output.String())
			}
		})
	}
}
