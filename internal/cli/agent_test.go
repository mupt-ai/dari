package cli

import (
	"github.com/mupt-ai/dari/internal/cli/agents"

	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestParseAgentLaunch(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		wantName string
		wantArgs []string
		wantOK   bool
		connect  bool
		setup    bool
		remove   bool
	}{
		{
			name:     "--setup and --remove-setup are Dari's",
			args:     []string{"codex", "--setup", "--remove-setup", "--", "--setup"},
			wantName: "codex",
			wantArgs: []string{"--", "--setup"},
			wantOK:   true,
			setup:    true,
			remove:   true,
		},
		{
			name:     "--connect is Dari's, but only before --",
			args:     []string{"claude", "--connect", "--print", "--", "--connect"},
			wantName: "claude",
			wantArgs: []string{"--print", "--", "--connect"},
			wantOK:   true,
			connect:  true,
		},
		{
			name:     "claude forwards every remaining token",
			args:     []string{"claude", "--print", "--", "-prompt"},
			wantName: "claude",
			wantArgs: []string{"--print", "--", "-prompt"},
			wantOK:   true,
		},
		{
			name:     "codex",
			args:     []string{"codex", "exec", "fix tests"},
			wantName: "codex",
			wantArgs: []string{"exec", "fix tests"},
			wantOK:   true,
		},
		{
			name:     "pi",
			args:     []string{"pi", "-p", "review"},
			wantName: "pi",
			wantArgs: []string{"-p", "review"},
			wantOK:   true,
		},
		{
			name:     "opencode",
			args:     []string{"opencode", "run", "review"},
			wantName: "opencode",
			wantArgs: []string{"run", "review"},
			wantOK:   true,
		},
		{
			name:   "ordinary Dari command",
			args:   []string{"router", "list"},
			wantOK: false,
		},
		{
			name:   "selector must be first",
			args:   []string{"--api-url", "https://example.test", "claude"},
			wantOK: false,
		},
		{
			name:   "old flag spelling is not a launcher",
			args:   []string{"--claude"},
			wantOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parseAgentLaunch(tt.args)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if got.name != tt.wantName {
				t.Errorf("name = %q, want %q", got.name, tt.wantName)
			}
			if got.connect != tt.connect {
				t.Errorf("connect = %v, want %v", got.connect, tt.connect)
			}
			if got.setup != tt.setup || got.removeSetup != tt.remove {
				t.Errorf("setup, removeSetup = %v, %v, want %v, %v", got.setup, got.removeSetup, tt.setup, tt.remove)
			}
			if !slices.Equal(got.args, tt.wantArgs) {
				t.Errorf("args = %q, want %q", got.args, tt.wantArgs)
			}
		})
	}
}

func TestAgentExecutableUsesManagedPathOverride(t *testing.T) {
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("DARI_CLAUDE_PATH", path)

	got, err := agentExecutable("claude")
	if err != nil {
		t.Fatal(err)
	}
	if got != path {
		t.Fatalf("agentExecutable() = %q, want %q", got, path)
	}
}

func TestAgentExecutableReportsInvalidManagedPathOverride(t *testing.T) {
	t.Setenv("DARI_CLAUDE_PATH", t.TempDir()+"/missing")

	_, err := agentExecutable("claude")
	if err == nil || !strings.Contains(err.Error(), "DARI_CLAUDE_PATH does not point to an executable file") {
		t.Fatalf("agentExecutable() error = %v", err)
	}
}

func TestBuildAgentCommandKeepsDariSettingsLast(t *testing.T) {
	tests := []struct {
		name       string
		launch     agentLaunch
		wantSuffix []string
		wantEnv    map[string]string
	}{
		{
			name: "claude",
			launch: agentLaunch{
				name: "claude",
				args: []string{"--model", "opus", "--print", "hello"},
			},
			wantSuffix: []string{"--model", agents.RoutingModel},
			wantEnv: map[string]string{
				"ANTHROPIC_BASE_URL":               routingBaseURL,
				"ANTHROPIC_AUTH_TOKEN":             "dari_route",
				"ANTHROPIC_API_KEY":                "",
				"CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1",
				"CLAUDE_CODE_MAX_CONTEXT_TOKENS":   "1000000",
				"CLAUDE_CODE_SUBAGENT_MODEL":       agents.RoutingModel,
			},
		},
		{
			name: "codex",
			launch: agentLaunch{
				name: "codex",
				args: []string{"exec", "-c", `model="other"`, "hello"},
			},
			wantSuffix: []string{
				"--config", `model="dari/routing"`,
				"--config", `model_provider="dari"`,
				"--config", `model_reasoning_summary="none"`,
				"--config", `model_providers.dari.name="Dari"`,
				"--config", `model_providers.dari.base_url="https://routing.dari.dev/v1"`,
				"--config", `model_providers.dari.env_key="DARI_ROUTING_API_KEY"`,
				"--config", `model_providers.dari.wire_api="responses"`,
			},
			wantEnv: map[string]string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			command, err := buildAgentCommand("/agent", tt.launch, "dari_route", routingBaseURL, agents.Models{Routing: true})
			if err != nil {
				t.Fatal(err)
			}
			if command.Cleanup != nil {
				defer command.Cleanup()
			}
			if !slices.Equal(command.Args[len(command.Args)-len(tt.wantSuffix):], tt.wantSuffix) {
				t.Errorf("args = %q, want suffix %q", command.Args, tt.wantSuffix)
			}
			if got := agents.EnvironmentValue(command.Env, agents.RoutingAPIKeyEnv); got != "dari_route" {
				t.Errorf("%s = %q", agents.RoutingAPIKeyEnv, got)
			}
			if got := agents.EnvironmentValue(command.Env, launchedRoutingKeyEnv); got != "1" {
				t.Errorf("%s = %q", launchedRoutingKeyEnv, got)
			}
			for name, want := range tt.wantEnv {
				if got := agents.EnvironmentValue(command.Env, name); got != want {
					t.Errorf("%s = %q, want %q", name, got, want)
				}
			}
		})
	}
}

func TestBuildAgentCommandInsertsSettingsBeforeDoubleDash(t *testing.T) {
	command, err := buildAgentCommand(
		"/claude",
		agentLaunch{name: "claude", args: []string{"--print", "--", "--help"}},
		"dari_route",
		routingBaseURL,
		agents.Models{Routing: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	if command.Cleanup != nil {
		defer command.Cleanup()
	}
	settingsIndex := slices.Index(command.Args, "--settings")
	modelIndex := slices.Index(command.Args, "--model")
	dashIndex := slices.Index(command.Args, "--")
	if settingsIndex < 0 || settingsIndex > dashIndex {
		t.Fatalf("args do not insert --settings before --: %q", command.Args)
	}
	if modelIndex < 0 || modelIndex+1 >= dashIndex {
		t.Fatalf("args do not insert --model before --: %q", command.Args)
	}
	if command.Args[modelIndex+1] != agents.RoutingModel {
		t.Fatalf("model = %q", command.Args[modelIndex+1])
	}
	if command.Args[0] != "--print" || command.Args[len(command.Args)-1] != "--help" {
		t.Fatalf("args = %q", command.Args)
	}
	if agents.OnlyRequestsInfo([]string{"--", "--help"}) {
		t.Fatal("prompt after -- was mistaken for the agent help flag")
	}
}

func TestResolveAgentRoutingKeyCreatesAndReusesKey(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		if r.URL.Path != "/v1/organizations/current/api-keys" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer dari_management" {
			t.Errorf("Authorization = %q", got)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["key_type"] != "routing" {
			t.Errorf("key_type = %q", body["key_type"])
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"api_key": "dari_routing"})
	}))
	defer server.Close()

	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	t.Setenv("DARI_API_URL", server.URL)
	t.Setenv("DARI_API_KEY", "dari_management")
	t.Setenv(agents.RoutingAPIKeyEnv, "")

	for range 2 {
		key, err := resolveAgentRoutingKey(context.Background(), strings.NewReader(""), io.Discard)
		if err != nil {
			t.Fatal(err)
		}
		if key != "dari_routing" {
			t.Errorf("key = %q", key)
		}
	}
	if requests != 1 {
		t.Fatalf("API requests = %d, want 1", requests)
	}
}

func TestResolveAgentRoutingKeyPrefersEnvironment(t *testing.T) {
	t.Setenv(agents.RoutingAPIKeyEnv, " dari_explicit ")
	t.Setenv(launchedRoutingKeyEnv, "")
	key, err := resolveAgentRoutingKey(context.Background(), strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if key != "dari_explicit" {
		t.Fatalf("key = %q", key)
	}
}

func TestResolveAgentRoutingKeyIgnoresLaunchedKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"api_key": "dari_current_org"})
	}))
	defer server.Close()

	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	t.Setenv("DARI_API_URL", server.URL)
	t.Setenv("DARI_API_KEY", "dari_management")
	t.Setenv(agents.RoutingAPIKeyEnv, "dari_parent_org")
	t.Setenv(launchedRoutingKeyEnv, "1")

	key, err := resolveAgentRoutingKey(context.Background(), strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if key != "dari_current_org" {
		t.Fatalf("key = %q", key)
	}
}

func TestRootHelpListsAgentLaunchers(t *testing.T) {
	cmd := newRootCmd("dev")
	var output strings.Builder
	cmd.SetOut(&output)
	cmd.SetArgs([]string{"--help"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"claude", "codex", "opencode", "pi", "muse", "openclaw", "hermes"} {
		if !strings.Contains(output.String(), "  "+name+" ") {
			t.Errorf("help does not list %s", name)
		}
	}
}

func TestClaudeCommandUsesSelectedRouter(t *testing.T) {
	for _, tc := range []struct{ routerID, want string }{
		{"", routingBaseURL},
		{"default", routingBaseURL},
		{"rtr_custom", routingBaseURL + "/rtr_custom"},
	} {
		t.Run(tc.routerID, func(t *testing.T) {
			command, err := buildAgentCommand("/claude", agentLaunch{name: "claude"}, "test-key", agentRoutingBaseURL(tc.routerID), agents.Models{Routing: true})
			if err != nil {
				t.Fatal(err)
			}
			if command.Cleanup != nil {
				defer command.Cleanup()
			}
			if got := agents.EnvironmentValue(command.Env, "ANTHROPIC_BASE_URL"); got != tc.want {
				t.Fatalf("base URL = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCodexCommandUsesSelectedRouter(t *testing.T) {
	for _, tc := range []struct{ routerID, want string }{
		{"", routingBaseURL},
		{"default", routingBaseURL},
		{"rtr_custom", routingBaseURL + "/rtr_custom"},
	} {
		t.Run(tc.routerID, func(t *testing.T) {
			command, err := buildAgentCommand("/codex", agentLaunch{name: "codex"}, "test-key", agentRoutingBaseURL(tc.routerID), agents.Models{Routing: true})
			if err != nil {
				t.Fatal(err)
			}
			want := `model_providers.dari.base_url="` + tc.want + `/v1"`
			found := false
			for _, arg := range command.Args {
				if arg == want {
					found = true
				}
			}
			if !found {
				t.Fatalf("missing %q in %v", want, command.Args)
			}
		})
	}
}

func TestPiCommandUsesSelectedRouter(t *testing.T) {
	// Pi starts on the organization default router, so its requests must go to that router, not the shared endpoint.
	command, err := buildAgentCommand("/pi", agentLaunch{name: "pi"}, "test-key", agentRoutingBaseURL("rtr_default"), agents.Models{Routing: true})
	if err != nil {
		t.Fatal(err)
	}
	if command.Cleanup != nil {
		defer command.Cleanup()
	}
	if got := agents.EnvironmentValue(command.Env, "DARI_ROUTING_BASE_URL"); got != routingBaseURL+"/rtr_default" {
		t.Fatalf("DARI_ROUTING_BASE_URL = %q", got)
	}
}
