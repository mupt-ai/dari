package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDreamerRunSendsTheCommandAndFailsOnItsExitStatus(t *testing.T) {
	useTestAPIKey(t)
	t.Setenv("DARI_GATEWAY_URL", "")
	var sent map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/organizations/current/dreamer/run" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&sent)
		_ = json.NewEncoder(w).Encode(map[string]any{"exit_code": 2, "output": "no such file\n"})
	}))
	defer srv.Close()

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "dreamer", "run", "--timeout", "30", "--", "ls", "-la", "missing"})
	output, err := captureStdoutBytes(t, cmd.Execute)
	if err == nil || !strings.Contains(err.Error(), "exited with status 2") {
		t.Fatalf("err = %v", err)
	}
	if string(output) != "no such file\n" {
		t.Fatalf("output %q", output)
	}
	if sent["command"] != "ls -la missing" || sent["timeout_seconds"] != float64(30) {
		t.Fatalf("sent %v", sent)
	}
}

func TestDreamerNeedsHostedDari(t *testing.T) {
	setGatewayEnv(t, "http://gateway.test:8080")
	hostedAPIMustNotBeCalled(t)
	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"dreamer", "start"})
	if _, err := captureStdoutBytes(t, cmd.Execute); err == nil || !strings.Contains(err.Error(), "hosted Dari") {
		t.Fatalf("err = %v", err)
	}
}
