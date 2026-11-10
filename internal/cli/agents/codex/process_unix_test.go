//go:build !windows

package codex

import (
	"context"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestCodexShutdownIncludesHangup(t *testing.T) {
	found := false
	for _, sig := range ShutdownSignals() {
		if sig == syscall.SIGHUP {
			found = true
		}
	}
	if !found {
		t.Fatal("terminal hangup must cancel launcher")
	}
}

func TestCodexGroupChild(t *testing.T) {
	if os.Getenv("DARI_TEST_GROUP_CHILD") != "1" {
		return
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM)
	if err := os.WriteFile(os.Getenv("DARI_TEST_CHILD_READY"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
		os.Exit(2)
	}
	for {
		time.Sleep(time.Hour)
	}
}

func TestCodexCancellationKillsToolChildren(t *testing.T) {
	ready := filepath.Join(t.TempDir(), "child")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	command := exec.CommandContext(ctx, "sh", "-c", `"$DARI_TEST_EXECUTABLE" -test.run=^TestCodexGroupChild$ & wait`)
	command.Env = append(os.Environ(), "DARI_TEST_GROUP_CHILD=1", "DARI_TEST_CHILD_READY="+ready, "DARI_TEST_EXECUTABLE="+executable)
	isolateCodexAppServer(command)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer cleanupCodexAppServer(command)
	var child int
	deadline := time.Now().Add(5 * time.Second)
	for child == 0 {
		data, err := os.ReadFile(ready)
		if err == nil {
			child, _ = strconv.Atoi(string(data))
		}
		if time.Now().After(deadline) {
			cancel()
			_ = command.Wait()
			t.Fatal("tool child not ready")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	done := make(chan struct{})
	go func() { _ = command.Wait(); cleanupCodexAppServer(command); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation did not finish")
	}
	// A killed orphan may briefly remain a zombie before the OS reaps it.
	for {
		if syscall.Kill(child, 0) == syscall.ESRCH {
			break
		}
		output, _ := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(child)).Output()
		if strings.Contains(string(output), "Z") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("tool child survived cancellation")
		}
		time.Sleep(time.Millisecond)
	}
}
