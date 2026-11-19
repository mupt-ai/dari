package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// On a gateway, a hosted command still runs against the hosted org and says
// so; without one it says nothing.
func TestHostedCommandOnGatewaySaysItActsOnTheHostedOrg(t *testing.T) {
	for _, onGateway := range []bool{true, false} {
		t.Run(map[bool]string{true: "gateway", false: "hosted"}[onGateway], func(t *testing.T) {
			useTestAPIKey(t)
			if onGateway {
				t.Setenv(gatewayURLEnv, "http://127.0.0.1:1")
				t.Setenv(gatewayKeyEnv, "gw")
			}
			server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"api_keys": []any{}})
			}))
			cmd := newRootCmd("dev")
			var stderr bytes.Buffer
			cmd.SetErr(&stderr)
			cmd.SetArgs([]string{"--api-url", server.URL, "api-keys", "list"})
			err := cmd.Execute()
			server.Close()
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Contains(stderr.String(), "Hosted Dari (DARI_API_KEY)"); got != onGateway {
				t.Fatalf("gateway = %v, stderr = %q", onGateway, stderr.String())
			}
		})
	}
}
