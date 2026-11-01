package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestFreshMachineReusesConfiguredMusePlan(t *testing.T) {
	useTestAPIKey(t)
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{{
				"id": "rtr_default", "name": "Default", "is_default": true,
				"enabled_models": []string{"openai/gpt-5.6-sol"},
			}, {
				"id": "rtr_muse", "name": "Dari Muse Code", "client_key": "dari-cli:muse-code",
				"enabled_models":         []string{"meta/muse-spark"},
				"model_providers":        map[string]string{"meta/muse-spark": "meta"},
				"subscription_providers": []string{"meta"},
			}}})
		case "/v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []map[string]string{{"oauth_provider": museSubscription.id}}})
		default:
			t.Errorf("configured Muse plan must not trigger setup: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	for range 2 {
		t.Setenv("DARI_CONFIG_DIR", t.TempDir())
		var output strings.Builder
		id, err := ensureAgentRouter(context.Background(), "muse", agentRoutingAccess{apiURL: server.URL}, strings.NewReader(""), &output)
		if err != nil {
			t.Fatal(err)
		}
		if id != "rtr_muse" || output.Len() != 0 {
			t.Fatalf("router=%q output=%q", id, output.String())
		}
	}
}
