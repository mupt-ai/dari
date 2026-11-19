package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/gateway"
)

// On a gateway, `--router <template>` fetches the template's spec from
// hosted Dari, saves it on the gateway under the template's name, and routes
// the launch there; `dari router apply <file>` saves a file under its name.
func TestGatewayRunsTemplatesAndSpecFiles(t *testing.T) {
	var mu sync.Mutex
	saved := map[string]string{}
	gateway := httptest.NewServer(requireGatewayKey(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/v1/routers/"):
			var body struct {
				SpecYAML string `json:"spec_yaml"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			id := strings.TrimPrefix(r.URL.Path, "/v1/routers/")
			saved[id] = body.SpecYAML
			_ = json.NewEncoder(w).Encode(map[string]string{"id": id, "name": "Saved"})
		case r.Method == http.MethodGet && r.URL.Path == "/deepseek-subagent/v1/models":
			_, _ = w.Write([]byte(gatewayCatalog))
		default:
			t.Errorf("unexpected gateway request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})))
	defer gateway.Close()
	setGatewayEnv(t, gateway.URL)
	hosted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// No sign-in: the template is fetched without a key.
		if r.URL.Path != "/v1/router-templates/deepseek-subagent/spec" || r.URL.Query().Get("format") != "yaml" || r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected hosted request %s %s", r.Method, r.URL.String())
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, "name: DeepSeek Subagent\n")
	}))
	defer hosted.Close()
	t.Setenv("DARI_API_URL", hosted.URL)

	launch := agentLaunch{name: "claude", args: []string{"--router", "deepseek-subagent", "-p", "hi"}}
	_, baseURL, _, err := resolveAgentRouting(context.Background(), &launch, strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if baseURL != gateway.URL+"/deepseek-subagent" || saved["deepseek-subagent"] != "name: DeepSeek Subagent\n" || strings.Join(launch.args, " ") != "-p hi" {
		t.Fatalf("baseURL = %q, saved = %v, args = %v", baseURL, saved, launch.args)
	}

	// A self-hosted gateway can't keep --default; nothing is saved first.
	delete(saved, "deepseek-subagent")
	launch = agentLaunch{name: "claude", args: []string{"--router", "deepseek-subagent", "--default"}}
	if _, _, _, err := resolveAgentRouting(context.Background(), &launch, strings.NewReader(""), io.Discard); err == nil || len(saved) != 0 {
		t.Fatalf("err = %v, saved = %v", err, saved)
	}

	file := filepath.Join(t.TempDir(), "my-router.yaml")
	if err := os.WriteFile(file, []byte("name: Mine\nmodels: [anthropic/claude-opus-5-5]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := newRootCmd("dev")
	cmd.SetOut(io.Discard)
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{"router", "apply", file})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if saved["my-router"] != "name: Mine\nmodels: [anthropic/claude-opus-5-5]\n" {
		t.Fatalf("saved = %v", saved)
	}
}

// Hosted, `dari setup <agent> --router <file> --default` applies the spec and
// moves the agent onto that router, asking nothing.
func TestSetupAppliesASpecFileAndMakesItTheDefault(t *testing.T) {
	useTestAPIKey(t)
	var requests []string
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/v1/organizations/current/routers/apply":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_spec", "name": "Mine"})
		case "/v1/organizations/current/routers/rtr_spec/coding-agents/claude_code":
			w.WriteHeader(http.StatusNoContent)
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{})
		}
	}))
	defer server.Close()
	client := api.New(server.URL).WithBearer("dari_test")
	file := filepath.Join(t.TempDir(), "router.yaml")
	if err := os.WriteFile(file, []byte("name: Mine\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	routerID, err := useHostedRouter(context.Background(), client, "claude", agentRouterChoice{name: file, makeDefault: true}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"POST /v1/organizations/current/routers/apply", "PUT /v1/organizations/current/routers/rtr_spec/coding-agents/claude_code"}
	if routerID != "rtr_spec" || strings.Join(requests, ",") != strings.Join(want, ",") {
		t.Fatalf("router = %q, requests = %v", routerID, requests)
	}
}

// Once --default made a spec router the agent's, setup and launches keep
// routing there; `--router default` is how setup goes back.
func TestGatewaySetupKeepsTheAgentsSpecRouter(t *testing.T) {
	gw := &gatewayConfig{url: "http://gateway.test", settings: gateway.Settings{AgentRouters: map[string]string{"claude": "opus-deepseek"}}}
	for _, reconfigure := range []bool{false, true} {
		launch := agentLaunch{name: "claude", reconfigure: reconfigure}
		baseURL, err := gatewayAgentRouter(context.Background(), gw, &launch, agentRouterChoice{}, strings.NewReader(""), io.Discard)
		if err != nil || baseURL != "http://gateway.test/opus-deepseek" {
			t.Fatalf("reconfigure = %v: %q, %v", reconfigure, baseURL, err)
		}
	}
}

// When an agent's router changes, the agent run directly follows where Dari
// is set up there, and stays untouched where it is not.
func TestChangingTheRouterMovesAnExistingCLISetup(t *testing.T) {
	setGatewayEnv(t, "http://gateway.test")
	settings := filepath.Join(os.Getenv("HOME"), ".claude", "settings.json")
	models := agents.Models{Enabled: []string{"anthropic/claude-opus-5-5"}}

	syncAgentSetup(context.Background(), "claude", "dari_key", "https://routing.dari.dev/rtr_new", models, io.Discard)
	if _, err := os.Stat(settings); !os.IsNotExist(err) {
		t.Fatalf("sync wrote a setup where there was none: %v", err)
	}

	if err := saveAgentConfig(context.Background(), "claude", "dari_key", "https://routing.dari.dev/rtr_old", models); err != nil {
		t.Fatal(err)
	}
	syncAgentSetup(context.Background(), "claude", "dari_key", "https://routing.dari.dev/rtr_new", models, io.Discard)
	data, err := os.ReadFile(settings)
	if err != nil || !strings.Contains(string(data), "https://routing.dari.dev/rtr_new") || strings.Contains(string(data), "rtr_old") {
		t.Fatalf("settings = %s, %v", data, err)
	}
}
