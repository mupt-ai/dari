package codex

import (
	"context"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestCodexWindowsProcessHelper(t *testing.T) {
	switch os.Getenv("DARI_TEST_WINDOWS_PROCESS") {
	case "tool":
		for {
			time.Sleep(time.Hour)
		}
	case "server":
		executable, err := os.Executable()
		if err != nil {
			os.Exit(2)
		}
		child := exec.Command(executable, "-test.run=^TestCodexWindowsProcessHelper$")
		child.Env = agents.WithEnvironment(os.Environ(), map[string]string{"DARI_TEST_WINDOWS_PROCESS": "tool"})
		if child.Start() != nil {
			os.Exit(2)
		}
		if os.WriteFile(os.Getenv("DARI_TEST_CHILD_READY"), []byte(strconv.Itoa(child.Process.Pid)), 0600) != nil {
			os.Exit(2)
		}
		_ = child.Wait()
		os.Exit(0)
	}
}

func TestCodexWindowsCancellationKillsToolChildren(t *testing.T) {
	ready := filepath.Join(t.TempDir(), "child")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	command := exec.CommandContext(ctx, executable, "-test.run=^TestCodexWindowsProcessHelper$")
	command.Env = agents.WithEnvironment(os.Environ(), map[string]string{"DARI_TEST_WINDOWS_PROCESS": "server", "DARI_TEST_CHILD_READY": ready})
	cleanup, err := startCodexAppServerProcess(command)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	defer func() { cancel(); _ = command.Wait() }()
	var child int
	deadline := time.Now().Add(5 * time.Second)
	for child == 0 {
		if data, err := os.ReadFile(ready); err == nil {
			child, _ = strconv.Atoi(string(data))
		}
		if time.Now().After(deadline) {
			t.Fatal("tool child did not start")
		}
		time.Sleep(time.Millisecond)
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(child))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	cancel()
	if result, err := windows.WaitForSingleObject(handle, 5000); err != nil || result != windows.WAIT_OBJECT_0 {
		t.Fatalf("tool child survived cancellation: result=%d err=%v", result, err)
	}
}
