package gateway

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"testing"
)

// The local gateway serves only the settings' keys, never a provider key or
// gateway setting from the launching shell, from its own directory, and with a
// config file only once the models commands wrote one.
func TestCommandEnvironment(t *testing.T) {
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("ANTHROPIC_API_KEY", "from-shell")
	t.Setenv("OPENAI_API_KEY", "from-shell")
	t.Setenv("OPENROUTER_API_KEY", "from-shell")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "from-shell")
	t.Setenv("DARI_GATEWAY_CONFIG", "/elsewhere/dari-gateway.yaml")
	t.Setenv("DARI_AUTO_ROUTING_API_KEY", "from-shell")
	settings := Settings{Mode: ModeLocal, LocalKey: "gw-key", ProviderKeys: map[string]string{"ANTHROPIC_API_KEY": "saved"}}

	cmd, err := Command(settings, nil)
	if err != nil {
		t.Fatal(err)
	}
	dir, _ := Dir()
	for _, want := range []string{"DARI_GATEWAY_KEYS=gw-key", "ANTHROPIC_API_KEY=saved", "PATH=/usr/bin", "PORT=7340"} {
		if !slices.Contains(cmd.Env, want) {
			t.Errorf("env missing %s", want)
		}
	}
	for _, unwanted := range []string{
		"ANTHROPIC_API_KEY=from-shell", "OPENAI_API_KEY=from-shell", "OPENROUTER_API_KEY=from-shell",
		"ANTHROPIC_AUTH_TOKEN=from-shell", "DARI_GATEWAY_CONFIG=/elsewhere/dari-gateway.yaml", "DARI_AUTO_ROUTING_API_KEY=from-shell",
	} {
		if slices.Contains(cmd.Env, unwanted) {
			t.Errorf("env has %s", unwanted)
		}
	}
	if cmd.Dir != dir {
		t.Errorf("dir = %q, want %q", cmd.Dir, dir)
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(dir, "config.json")
	if err := os.WriteFile(config, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	settings.AutoRoutingKey = "dari-key"
	cmd, err = Command(settings, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"DARI_GATEWAY_CONFIG=" + config, "DARI_AUTO_ROUTING_API_KEY=dari-key"} {
		if !slices.Contains(cmd.Env, want) {
			t.Errorf("env missing %s", want)
		}
	}
}

// fakeGateway installs a script as the gateway binary that never answers
// HTTP, like a gateway still starting, and starts it as Start would.
func fakeGateway(t *testing.T) *os.Process {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake gateway is a shell script")
	}
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	p, err := paths()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(p.binary), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.binary, []byte("#!/bin/sh\nsleep 60\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(p.binary)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	// Reap it as soon as it exits, as the init process does for a gateway
	// started by an earlier dari invocation.
	go func() { _, _ = cmd.Process.Wait() }()
	if err := os.WriteFile(p.pid, []byte(strconv.Itoa(cmd.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	return cmd.Process
}

// A gateway that does not answer yet is still running: Stop kills it rather
// than dropping its pid and leaving it behind.
func TestStopKillsGatewayThatDoesNotAnswer(t *testing.T) {
	process := fakeGateway(t)
	p, _ := paths()

	stopped, err := Stop(context.Background())
	if err != nil || !stopped {
		t.Fatalf("Stop = %v, %v; want stopped", stopped, err)
	}
	if gatewayRunning(process.Pid, p.binary) {
		t.Fatal("gateway still running after Stop")
	}
	if _, err := os.Stat(p.pid); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pid file left behind: %v", err)
	}
}

// A pid that now belongs to another program is stale: Stop leaves that
// program alone.
func TestStopIgnoresReusedPid(t *testing.T) {
	fakeGateway(t)
	p, _ := paths()
	if err := os.WriteFile(p.pid, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}

	stopped, err := Stop(context.Background())
	if err != nil || stopped {
		t.Fatalf("Stop = %v, %v; want not stopped", stopped, err)
	}
	if _, err := os.Stat(p.pid); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale pid file kept: %v", err)
	}
}

// A released CLI installs the gateway from its own release, so the two match;
// a dev build takes the latest.
func TestGatewayReleaseURL(t *testing.T) {
	for version, want := range map[string]string{
		"1.0.290":  "https://api.github.com/repos/mupt-ai/dari/releases/tags/v1.0.290",
		"v1.0.290": "https://api.github.com/repos/mupt-ai/dari/releases/tags/v1.0.290",
		"dev":      "https://api.github.com/repos/mupt-ai/dari/releases/latest",
	} {
		if got := gatewayReleaseURL(version); got != want {
			t.Errorf("gatewayReleaseURL(%q) = %q, want %q", version, got, want)
		}
	}
}
