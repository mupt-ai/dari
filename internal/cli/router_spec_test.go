package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `dari router apply` sends the file's spec as written; `get --yaml` prints
// the API's YAML.
func TestRouterSpecApplyAndGet(t *testing.T) {
	useTestAPIKey(t)
	var applied map[string]any
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/organizations/current/routers/apply":
			_ = json.NewDecoder(r.Body).Decode(&applied)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_1"})
		case "/v1/organizations/current/routers/rtr_1/spec":
			if r.URL.Query().Get("format") != "yaml" {
				http.Error(w, "want yaml", http.StatusBadRequest)
				return
			}
			_, _ = io.WriteString(w, "name: Opus + DeepSeek\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	file := filepath.Join(t.TempDir(), "router.yaml")
	if err := os.WriteFile(file, []byte("name: Opus + DeepSeek\nmodels:\n  - anthropic/claude-opus-5-5\n  - id: deepseek-ai/flash\n    provider: opencode-go\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) string {
		t.Helper()
		cmd := newRootCmd("dev")
		var out bytes.Buffer
		cmd.SetOut(&out)
		cmd.SetArgs(append([]string{"--api-url", server.URL, "router"}, args...))
		if err := cmd.Execute(); err != nil {
			t.Fatalf("dari router %v: %v", args, err)
		}
		return out.String()
	}

	run("apply", file, "--router", "rtr_1")
	if applied["router_id"] != "rtr_1" || !strings.HasPrefix(applied["spec_yaml"].(string), "name: Opus + DeepSeek\nmodels:") {
		t.Fatalf("applied = %v", applied)
	}

	want := "name: Opus + DeepSeek\n"
	if got := run("get", "rtr_1", "--yaml"); got != want {
		t.Fatalf("get --yaml =\n%s\nwant\n%s", got, want)
	}
}
