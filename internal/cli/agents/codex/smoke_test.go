package codex

import (
	"context"
	"encoding/json"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Optional installed-Codex smoke test. Run under a terminal/PTY with an isolated
// CODEX_HOME and a local mock endpoint/catalog; never points at a paid provider.
func TestCodexInstalledStatus(t *testing.T) {
	base := os.Getenv("DARI_TEST_CODEX_MOCK_URL")
	if base == "" {
		t.Skip("requires local Codex mock and terminal")
	}
	if !strings.HasPrefix(base, "http://127.0.0.1:") {
		t.Fatal("smoke test requires a loopback mock")
	}
	path, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	args := []string{"--no-alt-screen", "hello"}
	if encoded := os.Getenv("DARI_TEST_CODEX_ARGS"); encoded != "" {
		if err := json.Unmarshal([]byte(encoded), &args); err != nil {
			t.Fatal(err)
		}
	}
	// Point both the catalog and response paths at the explicit mock boundary.
	command := agents.Command{Path: path, Args: args, Env: agents.WithEnvironment(os.Environ(), map[string]string{agents.RoutingAPIKeyEnv: "test-key"})}
	Configure(&command, base, agents.Models{Routing: true})
	defer func() {
		if command.Cleanup != nil {
			command.Cleanup()
		}
	}()
	if err := PrepareCatalog(context.Background(), &command, "test-key", base, agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	if err := PrepareStatus(context.Background(), &command, args, "test-key", base); err != nil {
		t.Fatal(err)
	}
	process := exec.Command(command.Path, command.Args...)
	process.Env = command.Env
	process.Stdin = os.Stdin
	process.Stdout = os.Stdout
	process.Stderr = os.Stderr
	if err := process.Run(); err != nil {
		t.Fatal(err)
	}
}
