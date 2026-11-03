package cli

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/mupt-ai/dari-cli/internal/cli/agents"
)

const gatewayTestKey = "gw_test_key"

const gatewayCatalog = `{"models":[{"slug":"dari/routing","context_window":272000,"web_search_tool_type":null,"tool_mode":null,"multi_agent_version":null}]}`

// setGatewayEnv selects gateway mode with an isolated CLI state directory.
func setGatewayEnv(t *testing.T, gatewayURL string) {
	t.Helper()
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	t.Setenv("DARI_API_KEY", "")
	t.Setenv("DARI_GATEWAY_URL", gatewayURL)
	t.Setenv("DARI_GATEWAY_KEY", gatewayTestKey)
}

// hostedAPIMustNotBeCalled points the hosted API at a server that fails the
// test on any request, so a hosted call in gateway mode cannot go unnoticed.
func hostedAPIMustNotBeCalled(t *testing.T) {
	t.Helper()
	hosted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("gateway mode called the hosted API: %s %s", r.Method, r.URL.Path)
		http.Error(w, "hosted API must not be called", http.StatusTeapot)
	}))
	t.Cleanup(hosted.Close)
	t.Setenv("DARI_API_URL", hosted.URL)
}

// requireGatewayKey fails the test on any gateway request without the gateway
// bearer key.
func requireGatewayKey(t *testing.T, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+gatewayTestKey {
			t.Errorf("%s %s Authorization = %q", r.Method, r.URL.Path, got)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// fakeAgentExecutable installs a shell script as the agent. It records its
// environment and arguments in the returned file. The launcher must not
// know about the script, so it is found through DARI_<AGENT>_PATH.
func fakeAgentExecutable(t *testing.T, agent string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake agent executable is a shell script")
	}
	dir := t.TempDir()
	record := filepath.Join(dir, "launch.txt")
	script := filepath.Join(dir, agent)
	body := `#!/bin/sh
env > "$DARI_TEST_AGENT_OUT"
for arg in "$@"; do printf 'ARG %s\n' "$arg" >> "$DARI_TEST_AGENT_OUT"; done
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DARI_TEST_AGENT_OUT", record)
	t.Setenv("DARI_"+strings.ToUpper(agent)+"_PATH", script)
	return record
}

// readLaunchRecord splits what the fake agent recorded into its environment
// and its arguments.
func readLaunchRecord(t *testing.T, path string) (map[string]string, []string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{}
	var args []string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if arg, ok := strings.CutPrefix(line, "ARG "); ok {
			args = append(args, arg)
			continue
		}
		name, value, _ := strings.Cut(line, "=")
		env[name] = value
	}
	return env, args
}

func TestGatewayFromEnv(t *testing.T) {
	t.Setenv("DARI_GATEWAY_URL", "")
	t.Setenv("DARI_GATEWAY_KEY", "")
	if gateway, err := gatewayFromEnv(); gateway != nil || err != nil {
		t.Fatalf("unset gateway = %+v, %v", gateway, err)
	}

	t.Setenv("DARI_GATEWAY_KEY", gatewayTestKey)
	for _, tc := range []struct{ raw, want string }{
		{"http://gateway.test:8080", "http://gateway.test:8080"},
		{" https://gateway.test/ ", "https://gateway.test"},
		{"http://gateway.test:8080/v1", "http://gateway.test:8080"},
		{"http://gateway.test:8080/v1/", "http://gateway.test:8080"},
	} {
		t.Setenv("DARI_GATEWAY_URL", tc.raw)
		gateway, err := gatewayFromEnv()
		if err != nil || gateway == nil || gateway.url != tc.want || gateway.key != gatewayTestKey {
			t.Errorf("%q: gateway = %+v, %v; want url %q", tc.raw, gateway, err, tc.want)
		}
	}

	t.Setenv("DARI_GATEWAY_URL", "gateway.test:8080")
	if _, err := gatewayFromEnv(); err == nil || !strings.Contains(err.Error(), "DARI_GATEWAY_URL must be an http or https URL") {
		t.Errorf("schemeless URL error = %v", err)
	}

	t.Setenv("DARI_GATEWAY_URL", "http://gateway.test:8080")
	t.Setenv("DARI_GATEWAY_KEY", "  ")
	if _, err := gatewayFromEnv(); err == nil || !strings.Contains(err.Error(), "DARI_GATEWAY_KEY is required") {
		t.Errorf("missing key error = %v", err)
	}
}

func TestGatewayLaunchesMakeNoHostedCalls(t *testing.T) {
	var mu sync.Mutex
	var gatewayRequests []string
	gateway := httptest.NewServer(requireGatewayKey(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gatewayRequests = append(gatewayRequests, r.Method+" "+r.URL.Path)
		mu.Unlock()
		if r.Method == http.MethodGet && r.URL.Path == "/v1/models" {
			_, _ = w.Write([]byte(gatewayCatalog))
			return
		}
		t.Errorf("unexpected gateway request %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	})))
	defer gateway.Close()

	hostedAPIMustNotBeCalled(t)
	// A trailing /v1 is normalized away, and a stale hosted routing key must
	// not reach the agent.
	setGatewayEnv(t, gateway.URL+"/v1/")
	t.Setenv(agents.RoutingAPIKeyEnv, "stale_hosted_key")
	t.Setenv("DARI_CODEX_STATUS", "0")

	for _, tc := range []struct {
		agent       string
		wantGateway []string
		check       func(t *testing.T, env map[string]string, args []string)
	}{
		{"claude", []string{"GET /v1/models"}, func(t *testing.T, env map[string]string, _ []string) {
			if env["ANTHROPIC_BASE_URL"] != gateway.URL || env["ANTHROPIC_AUTH_TOKEN"] != gatewayTestKey {
				t.Errorf("Claude env = %q, %q", env["ANTHROPIC_BASE_URL"], env["ANTHROPIC_AUTH_TOKEN"])
			}
		}},
		{"codex", []string{"GET /v1/models", "GET /v1/models"}, func(t *testing.T, _ map[string]string, args []string) {
			want := `model_providers.dari.base_url="` + gateway.URL + `/v1"`
			if !slices.Contains(args, want) {
				t.Errorf("Codex args missing %s: %q", want, args)
			}
		}},
		{"opencode", []string{"GET /v1/models"}, func(t *testing.T, env map[string]string, _ []string) {
			if !strings.Contains(env["OPENCODE_CONFIG_CONTENT"], `"baseURL":"`+gateway.URL+`/v1"`) {
				t.Errorf("OpenCode config does not use the gateway: %q", env["OPENCODE_CONFIG_CONTENT"])
			}
		}},
		{"pi", []string{"GET /v1/models"}, func(t *testing.T, env map[string]string, _ []string) {
			if env["DARI_ROUTING_BASE_URL"] != gateway.URL {
				t.Errorf("Pi base URL = %q", env["DARI_ROUTING_BASE_URL"])
			}
		}},
	} {
		t.Run(tc.agent, func(t *testing.T) {
			record := fakeAgentExecutable(t, tc.agent)
			mu.Lock()
			gatewayRequests = nil
			mu.Unlock()

			var stderr strings.Builder
			code := runAgentLaunch(context.Background(), agentLaunch{name: tc.agent, args: []string{"hello"}}, strings.NewReader(""), io.Discard, &stderr)
			if code != 0 || stderr.Len() != 0 {
				t.Fatalf("exit %d, stderr %q", code, stderr.String())
			}
			env, args := readLaunchRecord(t, record)
			if env[agents.RoutingAPIKeyEnv] != gatewayTestKey {
				t.Errorf("%s = %q, want the gateway key", agents.RoutingAPIKeyEnv, env[agents.RoutingAPIKeyEnv])
			}
			tc.check(t, env, args)

			mu.Lock()
			defer mu.Unlock()
			if !slices.Equal(gatewayRequests, tc.wantGateway) {
				t.Errorf("gateway requests = %q, want %q", gatewayRequests, tc.wantGateway)
			}
		})
	}
}

func TestGatewayLaunchNeedsGatewayKey(t *testing.T) {
	hostedAPIMustNotBeCalled(t)
	fakeAgentExecutable(t, "claude")
	setGatewayEnv(t, "http://gateway.test:8080")
	t.Setenv("DARI_GATEWAY_KEY", "")

	var stderr strings.Builder
	code := runAgentLaunch(context.Background(), agentLaunch{name: "claude", args: []string{"hello"}}, strings.NewReader(""), io.Discard, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "DARI_GATEWAY_KEY is required") {
		t.Fatalf("exit %d, stderr %q", code, stderr.String())
	}
}

func TestGatewayLaunchRejectsHostedConnect(t *testing.T) {
	hostedAPIMustNotBeCalled(t)
	fakeAgentExecutable(t, "pi")
	setGatewayEnv(t, "http://gateway.test:8080")

	var stderr strings.Builder
	code := runAgentLaunch(context.Background(), agentLaunch{name: "pi", args: []string{"hello"}, connect: true}, strings.NewReader(""), io.Discard, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "--connect manages hosted accounts") {
		t.Fatalf("exit %d, stderr %q", code, stderr.String())
	}
}

func TestGatewaySubscriptionCommandsUseGatewayKey(t *testing.T) {
	seen := map[string]map[string]any{}
	gateway := httptest.NewServer(requireGatewayKey(t, multipleSubscriptionsHandler(t, seen)))
	defer gateway.Close()

	hostedAPIMustNotBeCalled(t)
	setGatewayEnv(t, gateway.URL)
	original := openAgentBrowser
	openAgentBrowser = func(string) bool { return false }
	t.Cleanup(func() { openAgentBrowser = original })

	run := func(stdin string, args ...string) error {
		cmd := newRootCmd("dev")
		cmd.SetIn(strings.NewReader(stdin))
		cmd.SetErr(&strings.Builder{})
		cmd.SetArgs(append([]string{"credentials", "subscription"}, args...))
		return captureStdout(t, cmd.Execute)
	}
	for _, tc := range []struct {
		stdin string
		args  []string
		want  string
	}{
		{"", []string{"list"}, "GET /v1/organizations/current/credentials"},
		{"\n", []string{"connect", "codex"}, "POST /v1/organizations/current/credentials/oauth/sessions/complete"},
		{"", []string{"rename", "claude-code", "Work Max"}, "PUT /v1/organizations/current/credentials/ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN/label"},
		{"", []string{"mark-available", "openai_codex_oauth_token"}, "POST /v1/organizations/current/credentials/OPENAI_CODEX_OAUTH_TOKEN/mark-available"},
		{"", []string{"disconnect", "claude-code"}, "DELETE /v1/organizations/current/credentials/ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN"},
	} {
		if err := run(tc.stdin, tc.args...); err != nil {
			t.Fatalf("subscription %v: %v", tc.args, err)
		}
		if _, ok := seen[tc.want]; !ok {
			t.Errorf("subscription %v did not reach the gateway as %s", tc.args, tc.want)
		}
	}
	if _, ok := seen["POST /v1/organizations/current/credentials/oauth/sessions"]; !ok {
		t.Error("connect did not start an OAuth session on the gateway")
	}

	err := run("", "auto-reset", "openai_codex_oauth_token_2", "on")
	if err == nil || !strings.Contains(err.Error(), "not supported with DARI_GATEWAY_URL") {
		t.Fatalf("auto-reset error = %v", err)
	}
	if _, ok := seen["PUT /v1/organizations/current/credentials/OPENAI_CODEX_OAUTH_TOKEN_2/auto-reset"]; ok {
		t.Error("auto-reset reached the gateway")
	}
}

func TestGatewayRequestCostsAreHostedOnly(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected gateway request %s %s", r.Method, r.URL.Path)
	}))
	defer gateway.Close()

	hostedAPIMustNotBeCalled(t)
	setGatewayEnv(t, gateway.URL)

	cmd := newRouterRequestCostsCmd()
	cmd.SetArgs([]string{"35fcb4c6-5902-40a7-adfe-e9289cab6855"})
	err := captureStdout(t, cmd.Execute)
	if err == nil || !strings.Contains(err.Error(), "only available on the hosted Dari API") {
		t.Fatalf("expected a hosted-only error, got %v", err)
	}
}

func TestGatewayProviderCredentialsNameGatewayEnvironment(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected gateway request %s %s", r.Method, r.URL.Path)
	}))
	defer gateway.Close()

	hostedAPIMustNotBeCalled(t)
	setGatewayEnv(t, gateway.URL)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"credentials", "provider", "add", "anthropic", "Anthropic", "--value-stdin"})
	cmd.SetIn(strings.NewReader("sk-test\n"))
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	if err := cmd.Execute(); !errors.Is(err, errGatewayProviderKeys) || !strings.Contains(err.Error(), "ANTHROPIC_API_KEY") {
		t.Fatalf("provider add error = %v", err)
	}
}

func TestGatewayModelsListTheGatewaysRouter(t *testing.T) {
	gateway := httptest.NewServer(requireGatewayKey(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"models":[{"slug":"dari/routing"},{"slug":"dari/model/anthropic/claude-opus-5-5"},{"slug":"dari/model/vercel-ai-gateway/openai/gpt-6.1-sol"}]}`))
	})))
	defer gateway.Close()

	models, err := routerModels(context.Background(), gateway.URL, gatewayTestKey)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"dari/routing", "dari/model/anthropic/claude-opus-5-5", "dari/model/vercel-ai-gateway/openai/gpt-6.1-sol"}; !slices.Equal(models.Menu(), want) {
		t.Errorf("menu = %q, want %q", models.Menu(), want)
	}
}

// Hermes runs every session in a shared gateway, so a launch writes Dari into
// Hermes's own config before starting it, and forwards its arguments as is.
func TestGatewayHermesLaunchWritesSetupBeforeStarting(t *testing.T) {
	gateway := httptest.NewServer(requireGatewayKey(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(gatewayCatalog))
	})))
	defer gateway.Close()
	hostedAPIMustNotBeCalled(t)
	setGatewayEnv(t, gateway.URL)
	if runtime.GOOS == "windows" {
		t.Skip("fake agent executable is a shell script")
	}
	dir := t.TempDir()
	config := filepath.Join(dir, "config.yaml")
	record := filepath.Join(dir, "launch.txt")
	script := filepath.Join(dir, "hermes")
	body := `#!/bin/sh
if [ "$1 $2" = "config path" ]; then echo "` + config + `"; exit 0; fi
[ -f "` + config + `" ] && echo configured > "` + record + `"
for arg in "$@"; do printf 'ARG %s\n' "$arg" >> "` + record + `"; done
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DARI_HERMES_PATH", script)

	var stderr strings.Builder
	code := runAgentLaunch(context.Background(), agentLaunch{name: "hermes", args: []string{"chat", "-q", "hello"}}, strings.NewReader(""), io.Discard, &stderr)
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr.String())
	}
	data, err := os.ReadFile(config)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"provider: dari", "base_url: " + gateway.URL + "/v1", "api_key: " + gatewayTestKey} {
		if !strings.Contains(string(data), want) {
			t.Errorf("Hermes config missing %q:\n%s", want, data)
		}
	}
	launched, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	if want := "configured\nARG chat\nARG -q\nARG hello\n"; string(launched) != want {
		t.Fatalf("launch = %q, want %q", launched, want)
	}
	if !strings.Contains(stderr.String(), "`dari hermes --remove-setup` undoes it") {
		t.Errorf("launch does not say it set Hermes up: %q", stderr.String())
	}
}
