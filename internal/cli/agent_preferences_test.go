package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/mupt-ai/dari/internal/api"
)

// Model and OAuth tests share a server-side preference store, independently of
// the machine's configuration directory.
func newAgentTestServer(handler http.Handler) *httptest.Server {
	var mu sync.Mutex
	preferences := map[string]agentPreferences{}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "/v1/organizations/current/agent-preferences/"
		if !strings.HasPrefix(r.URL.Path, prefix) {
			handler.ServeHTTP(w, r)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		agent := strings.TrimPrefix(r.URL.Path, prefix)
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(preferences[agent])
		case http.MethodPut:
			var pref agentPreferences
			if err := json.NewDecoder(r.Body).Decode(&pref); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			preferences[agent] = pref
			_ = json.NewEncoder(w).Encode(pref)
		default:
			http.Error(w, "method", 405)
		}
	}))
}

func TestAgentPreferencesSurviveFreshMachine(t *testing.T) {
	server := newAgentTestServer(http.NotFoundHandler())
	defer server.Close()
	for _, agent := range []string{"claude", "codex", "opencode", "pi", "muse"} {
		t.Run(agent, func(t *testing.T) {
			ctx := context.Background()
			first := api.New(server.URL).WithBearer("key")
			if err := saveAgentSubscriptionOptOut(ctx, first, agent, true); err != nil {
				t.Fatal(err)
			}
			t.Setenv("DARI_CONFIG_DIR", t.TempDir())
			second := api.New(server.URL).WithBearer("key")
			optedOut, err := agentSubscriptionOptedOut(ctx, second, agent)
			if err != nil || !optedOut {
				t.Fatalf("preference = %v, %v", optedOut, err)
			}
		})
	}
}

func TestAgentPreferenceServerFailureIsNotLocalFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "unavailable", 503) }))
	defer server.Close()
	client := api.New(server.URL)
	if _, err := agentSubscriptionOptedOut(context.Background(), client, "pi"); err == nil {
		t.Fatal("read should fail")
	}
	if err := saveAgentSubscriptionOptOut(context.Background(), client, "pi", true); err == nil {
		t.Fatal("write should fail")
	}
}
