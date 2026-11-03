package opencode

import (
	"encoding/json"
	"github.com/mupt-ai/dari-cli/internal/cli/agents"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestDirectModelsOfferThinkingVariants(t *testing.T) {
	raw, err := openCodeConfig("http://localhost", "plugin", agents.Models{Routing: true, Enabled: []string{"openai/gpt-5.5"}})
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Provider map[string]struct {
			Models map[string]struct {
				Reasoning bool                         `json:"reasoning"`
				Variants  map[string]map[string]string `json:"variants"`
			} `json:"models"`
		} `json:"provider"`
	}
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}
	models := config.Provider["dari"].Models
	if models["routing"].Reasoning || len(models["routing"].Variants) != 0 {
		t.Fatal("router must choose its own thinking level")
	}
	direct := models["model/openai/gpt-5.5"]
	if !direct.Reasoning {
		t.Fatal("direct model does not support thinking selection")
	}
	for _, effort := range []string{"low", "medium", "high"} {
		if direct.Variants[effort]["reasoningEffort"] != effort {
			t.Fatalf("missing %s thinking variant", effort)
		}
	}
}

func TestBuildOpenCodeCommandInjectsSessionConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// os.UserCacheDir prefers XDG_CACHE_HOME on Linux.
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	command := launch()
	if err := Configure(&command, "https://routing.dari.dev/router_1", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	// The plugin sits at a stable cache path, so the launch needs no cleanup and
	// can hand its process to OpenCode.
	if command.Cleanup != nil {
		t.Fatal("OpenCode command should not need cleanup: its plugin is cached")
	}
	if !slices.Equal(command.Args, []string{"--standalone"}) {
		t.Fatalf("args = %q", command.Args)
	}
	raw := agents.EnvironmentValue(command.Env, "OPENCODE_CONFIG_CONTENT")
	if strings.Contains(raw, "dari_route") {
		t.Fatal("config contains the secret key")
	}
	var config struct {
		Model            string                       `json:"model"`
		SmallModel       string                       `json:"small_model"`
		EnabledProviders []string                     `json:"enabled_providers"`
		Agent            map[string]map[string]string `json:"agent"`
		Plugins          []string                     `json:"plugins"`
		Provider         map[string]struct {
			Options map[string]string `json:"options"`
			Models  map[string]struct {
				ID         string              `json:"id"`
				Attachment bool                `json:"attachment"`
				Limit      map[string]int      `json:"limit"`
				Modalities map[string][]string `json:"modalities"`
			} `json:"models"`
		} `json:"provider"`
	}
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(config.EnabledProviders, []string{"dari"}) {
		t.Errorf("enabled_providers = %q, want only dari in /models", config.EnabledProviders)
	}
	if config.Model != agents.RoutingModel || config.SmallModel != agents.RoutingModel {
		t.Errorf("model = %q, small_model = %q", config.Model, config.SmallModel)
	}
	for _, name := range []string{"general", "explore", "scout", "title", "summary", "compaction"} {
		if config.Agent[name]["model"] != agents.RoutingModel {
			t.Errorf("agent %s model = %q", name, config.Agent[name]["model"])
		}
	}
	// Primary agents follow /models.
	for _, name := range []string{"build", "plan"} {
		if _, pinned := config.Agent[name]; pinned {
			t.Errorf("agent %s is pinned", name)
		}
	}
	dari := config.Provider["dari"]
	if dari.Options["baseURL"] != "https://routing.dari.dev/router_1/v1" {
		t.Errorf("baseURL = %q", dari.Options["baseURL"])
	}
	if dari.Options["apiKey"] != "{env:DARI_ROUTING_API_KEY}" {
		t.Errorf("apiKey = %q", dari.Options["apiKey"])
	}
	model := dari.Models["routing"]
	if model.ID != agents.RoutingModel {
		t.Errorf("model id = %q", model.ID)
	}
	if !model.Attachment || !slices.Contains(model.Modalities["input"], "image") {
		t.Errorf("model does not accept images: %+v", model)
	}
	if model.Limit["context"] != 1_000_000 {
		t.Errorf("context = %d", model.Limit["context"])
	}

	if len(config.Plugins) != 1 {
		t.Fatalf("plugins = %q", config.Plugins)
	}
	plugin := config.Plugins[0]
	server, err := os.ReadFile(filepath.Join(plugin, "server.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`ctx.session.hook("model.request"`, `"x-opencode-request-kind"`, `"x-opencode-agent"`, `ctx.session.hook("http.response"`, `"x-dari-selected-model"`, `"agent-status", "--headers"`, `providerID: "dari"`,
		`, ...args], { stdout: "pipe"`,
		`process.env.DARI_STATUS_EXECUTABLE`,
		`generations[sessionID] !== generation`,
	} {
		if !strings.Contains(string(server), want) {
			t.Errorf("server plugin does not record routing status (%s missing)", want)
		}
	}
	if string(server) != serverPlugin {
		t.Error("server plugin differs from agents/opencode/server.ts")
	}
	if agents.EnvironmentValue(command.Env, "DARI_STATUS_EXECUTABLE") == "" {
		t.Errorf("status environment = %q", agents.EnvironmentValue(command.Env, "DARI_STATUS_EXECUTABLE"))
	}
	tui, err := os.ReadFile(filepath.Join(plugin, "tui.tsx"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(tui), `append: "prompt.footer.status"`) {
		t.Errorf("TUI plugin does not show routing status: %s", tui)
	}

}

func TestBuildOpenCodeCommandArguments(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// os.UserCacheDir prefers XDG_CACHE_HOME on Linux.
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{"directory", []string{"./repo"}, []string{"./repo", "--standalone"}},
		{"run replaces user model", []string{"run", "-m", "openai/gpt", "fix it"}, []string{"run", "fix it", "--standalone", "--model", agents.RoutingModel}},
		{"run keeps prompt after double dash", []string{"run", "--", "--help"}, []string{"run", "--standalone", "--model", agents.RoutingModel, "--", "--help"}},
		{"mini replaces user model", []string{"mini", "--model=openai/gpt"}, []string{"mini", "--standalone", "--model", agents.RoutingModel}},
		{"explicit standalone", []string{"--standalone", "--auto"}, []string{"--standalone", "--auto"}},
		{"mini", []string{"mini"}, []string{"mini", "--standalone", "--model", agents.RoutingModel}},
		{"models command does not get model flag", []string{"models"}, []string{"models", "--standalone"}},
		{"stats command does not get model flag", []string{"stats"}, []string{"stats", "--standalone"}},
		{"api uses private server without model flag", []string{"api", "GET", "/session"}, []string{"api", "GET", "/session", "--standalone"}},
		{"leading flag before models", []string{"--print-logs", "models"}, []string{"--print-logs", "models", "--standalone"}},
		{"leading valued flag before serve", []string{"--log-level", "debug", "serve"}, []string{"--log-level", "debug", "serve"}},
		{"leading valued flag before run", []string{"--log-level", "debug", "run", "hi"}, []string{"--log-level", "debug", "run", "hi", "--standalone", "--model", agents.RoutingModel}},
		{"interactive session value is not a subcommand", []string{"-s", "ses_1"}, []string{"-s", "ses_1", "--standalone"}},
		{"serve inherits environment", []string{"serve"}, []string{"serve"}},
		{"help", []string{"--help"}, []string{"--help"}},
		{"version", []string{"run", "-v"}, []string{"run", "-v"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			command := launch(tt.args...)
			if err := Configure(&command, "https://routing.dari.dev", agents.Models{Routing: true}); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(command.Args, tt.want) {
				t.Fatalf("args = %q, want %q", command.Args, tt.want)
			}
			if agents.EnvironmentValue(command.Env, "OPENCODE_CONFIG_CONTENT") == "" {
				t.Fatal("OpenCode config was not injected")
			}
		})
	}
}

func TestBuildOpenCodeManagementCommandsGetNoDariConfig(t *testing.T) {
	for _, args := range [][]string{{"service", "start"}, {"session", "list"}, {"--print-logs", "service", "restart"}} {
		command := launch(args...)
		if err := Configure(&command, "https://routing.dari.dev", agents.Models{Routing: true}); err != nil {
			t.Fatal(err)
		}
		if command.Cleanup != nil {
			t.Errorf("%q needs cleanup for a plugin it did not write", args)
		}
		if !slices.Equal(command.Args, args) {
			t.Errorf("args = %q, want %q", command.Args, args)
		}
		for _, name := range []string{"OPENCODE_CONFIG_CONTENT", agents.RoutingAPIKeyEnv} {
			if agents.EnvironmentValue(command.Env, name) != "" {
				t.Errorf("%q passes %s to the shared service", args, name)
			}
		}
	}
}

func TestBuildOpenCodeCommandRejectsPairing(t *testing.T) {
	command := launch("--print-logs", "pair")
	err := Configure(&command, "https://routing.dari.dev", agents.Models{Routing: true})
	if err == nil || !strings.Contains(err.Error(), "dari opencode serve") {
		t.Fatalf("error = %v", err)
	}
}

func TestBuildOpenCodeCommandRejectsSharedServer(t *testing.T) {
	command := launch("--server", "http://127.0.0.1:4096")
	err := Configure(&command, "https://routing.dari.dev", agents.Models{Routing: true})
	if err == nil || !strings.Contains(err.Error(), "remove --server") {
		t.Fatalf("error = %v", err)
	}
}

// statusPluginCommand runs a bun harness in dir with the environment an agent
// launch sets, using renderScript as the status renderer.
func statusPluginCommand(t *testing.T, bun, dir, renderScript string) *exec.Cmd {
	t.Helper()
	script := filepath.Join(dir, "render.ts")
	renderer := filepath.Join(dir, "render.sh")
	if err := os.WriteFile(script, []byte(renderScript), 0o600); err != nil {
		t.Fatal(err)
	}
	wrapper := "#!/bin/sh\nexec " + agents.ShellQuote(bun) + " " + agents.ShellQuote(script) + " \"$@\"\n"
	if err := os.WriteFile(renderer, []byte(wrapper), 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bun, "run.ts")
	cmd.Dir = dir
	cmd.Env = agents.WithEnvironment(os.Environ(), map[string]string{"DARI_STATUS_EXECUTABLE": renderer})
	return cmd
}

// launch builds the command the launcher passes to Configure: OpenCode's
// arguments with the routing key in the environment.
func launch(args ...string) agents.Command {
	return agents.Command{Path: "/opencode", Args: args, Env: []string{agents.RoutingAPIKeyEnv + "=dari_route"}}
}
