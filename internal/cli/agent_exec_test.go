package cli

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/mupt-ai/dari-cli/internal/cli/agents"
)

const (
	launchHelperEnv = "DARI_TEST_LAUNCH_HELPER"
	launchAgentEnv  = "DARI_TEST_LAUNCH_AGENT"
)

// launchTestGateway starts a gateway that serves the test catalog and selects it
// as the launch's routing endpoint.
func launchTestGateway(t *testing.T) {
	t.Helper()
	gateway := httptest.NewServer(requireGatewayKey(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(gatewayCatalog))
	})))
	t.Cleanup(gateway.Close)
	setGatewayEnv(t, gateway.URL)
	hostedAPIMustNotBeCalled(t)
}

// launchHelper returns a child process that runs the launch named by
// launchAgentEnv, with the launcher's own standard streams. A launch can
// replace its process, so it must not run in the test process itself.
func launchHelper(t *testing.T, test, agent string) (*exec.Cmd, *bytes.Buffer) {
	t.Helper()
	var stderr bytes.Buffer
	helper := exec.Command(os.Args[0], "-test.run=^"+test+"$")
	helper.Env = append(os.Environ(), launchHelperEnv+"=1", launchAgentEnv+"="+agent)
	helper.Stderr = &stderr
	return helper, &stderr
}

// runLaunchHelper is the child side of launchHelper.
func runLaunchHelper() {
	os.Exit(runAgentLaunch(context.Background(), agentLaunch{name: os.Getenv(launchAgentEnv), args: []string{"hello"}}, os.Stdin, os.Stdout, os.Stderr))
}

// TestLaunchHandsProcessToAgent checks which agents run as the launcher's own
// process. An agent that keeps launcher state, such as Codex's status bridge,
// must stay a child so the launcher can serve it and clean up after it.
func TestLaunchHandsProcessToAgent(t *testing.T) {
	if !agents.CanReplaceProcess {
		t.Skip("process replacement is Unix-only")
	}
	if os.Getenv(launchHelperEnv) == "1" {
		runLaunchHelper()
	}
	launchTestGateway(t)
	t.Setenv("DARI_CODEX_STATUS", "0")

	for _, tc := range []struct {
		agent    string
		replaced bool
	}{
		{"claude", true},
		{"pi", true},
		{"opencode", true},
		{"codex", false},
	} {
		t.Run(tc.agent, func(t *testing.T) {
			record := fakeAgentExecutable(t, tc.agent)
			helper, stderr := launchHelper(t, "TestLaunchHandsProcessToAgent", tc.agent)
			if err := helper.Start(); err != nil {
				t.Fatal(err)
			}
			launcherPID := helper.Process.Pid
			if err := helper.Wait(); err != nil {
				t.Fatalf("launch failed: %v, stderr %q", err, stderr.String())
			}
			env, _ := readLaunchRecord(t, record)
			agentPID, err := strconv.Atoi(env["DARI_TEST_PID"])
			if err != nil {
				t.Fatalf("no agent pid recorded: %v", err)
			}
			if got := agentPID == launcherPID; got != tc.replaced {
				t.Fatalf("agent pid %d, launcher pid %d: replaced = %v, want %v", agentPID, launcherPID, got, tc.replaced)
			}
		})
	}
}

// TestLaunchReportsFailedExec checks that a Claude binary the launcher cannot
// execute is reported as a failed start, with the same message and exit code
// as a child that fails to start.
func TestLaunchReportsFailedExec(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process replacement is Unix-only")
	}
	if os.Getenv(launchHelperEnv) == "1" {
		runLaunchHelper()
	}
	launchTestGateway(t)

	// Executable, but with no program format the kernel can run.
	script := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(script, []byte("not a program\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DARI_CLAUDE_PATH", script)

	helper, stderr := launchHelper(t, "TestLaunchReportsFailedExec", "claude")
	err := helper.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
		t.Fatalf("launch exit = %v, want exit 1", err)
	}
	want := "start claude: fork/exec " + script + ": exec format error"
	if !strings.Contains(stderr.String(), want) {
		t.Fatalf("stderr = %q, want %q", stderr.String(), want)
	}
}
