package pi

import (
	"github.com/mupt-ai/dari/internal/cli/agents"
	"os"
	"slices"
	"strings"
	"testing"
)

func TestBuildPiAgentCommandWritesCachedProviderExtension(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// os.UserCacheDir prefers XDG_CACHE_HOME on Linux.
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	command := agents.Command{Path: "/pi", Args: []string{"-p", "review"}, Env: []string{agents.RoutingAPIKeyEnv + "=dari_route"}}
	if err := Configure(&command, "https://routing.test/rtr_1", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	// The extension sits at a stable cache path, so the launch needs no cleanup
	// and can hand its process to Pi.
	if command.Cleanup != nil {
		t.Fatal("Pi command should not need cleanup: its extension is cached")
	}
	if got := agents.EnvironmentValue(command.Env, "DARI_ROUTING_BASE_URL"); got != "https://routing.test/rtr_1" {
		t.Fatalf("DARI_ROUTING_BASE_URL = %q", got)
	}

	extensionIndex := slices.Index(command.Args, "--extension")
	if extensionIndex < 0 || extensionIndex+1 >= len(command.Args) {
		t.Fatalf("args do not contain an extension: %q", command.Args)
	}
	path := command.Args[extensionIndex+1]
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if !strings.Contains(content, `pi.registerProvider("dari"`) {
		t.Errorf("extension does not register Dari: %s", content)
	}
	for _, want := range []string{
		`pi.on("after_provider_response"`,
		`reasoning: id !== "dari/routing"`,
		`x-dari-selected-model`,
		`"agent-status", "--headers"`,
		`ctx.ui.setStatus("dari"`,
		`process.env.DARI_STATUS_EXECUTABLE`,
		"baseUrl: `${routingBaseURL}/v1`", `process.env.DARI_ROUTING_BASE_URL ?? "https://routing.dari.dev"`,
		`revision === expectedRevision`,
	} {
		if !strings.Contains(content, want) {
			t.Errorf("extension does not show routing status (%s missing): %s", want, content)
		}
	}
	if strings.Contains(content, "dari_route") {
		t.Fatal("extension contains the secret key")
	}
	if content != extension {
		t.Error("extension differs from agents/pi/extension.ts")
	}
	if agents.EnvironmentValue(command.Env, "DARI_STATUS_EXECUTABLE") == "" {
		t.Errorf("status environment = %q", agents.EnvironmentValue(command.Env, "DARI_STATUS_EXECUTABLE"))
	}
}

func TestPiScopesModelPickerToTheRouter(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// os.UserCacheDir prefers XDG_CACHE_HOME on Linux.
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	command := agents.Command{Path: "/pi"}
	if err := Configure(&command, "https://routing.dari.dev", agents.Models{Enabled: []string{"openai/gpt-6-luna", "anthropic/claude-sonnet-5-5"}}); err != nil {
		t.Fatal(err)
	}
	index := slices.Index(command.Args, "--models")
	if index < 0 || command.Args[index+1] != "dari/dari/model/openai/gpt-6-luna,dari/dari/model/anthropic/claude-sonnet-5-5" {
		t.Fatalf("args = %q, want the router's models scoped", command.Args)
	}

	// A scope the user chose stays theirs.
	command = agents.Command{Path: "/pi", Args: []string{"--models", "mine/*"}}
	if err := Configure(&command, "https://routing.dari.dev", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	if strings.Count(strings.Join(command.Args, " "), "--models") != 1 {
		t.Fatalf("args = %q, want the user's --models only", command.Args)
	}
}
