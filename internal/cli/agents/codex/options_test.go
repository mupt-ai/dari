package codex

import (
	"context"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestCodexServerOptions(t *testing.T) {
	options, directory := codexServerOptions([]string{
		"resume", "--last", "-C", "/tmp/project", "-cfoo=1", "--config=bar=2",
		"--enable", "tools", "--disable=test", "--strict-config", "--", "-c", "ignored=1",
	})
	want := []string{"app-server", "-c", "foo=1", "--config", "bar=2", "--enable", "tools", "--disable", "test", "--strict-config"}
	if !slices.Equal(options, want) || directory != "/tmp/project" {
		t.Fatalf("%q %q", options, directory)
	}
	for _, args := range [][]string{{"--remote=ws://test"}, {"-pwork"}, {"--profile", "work"}} {
		if !codexCustomConnection(args) {
			t.Fatalf("not bypassed: %q", args)
		}
	}
	if codexCustomConnection([]string{"--", "--profile"}) {
		t.Fatal("parsed prompt as flag")
	}
}

func TestCodexStatusBypassAndCleanup(t *testing.T) {
	for _, args := range [][]string{{"exec", "hello"}, {"review"}, {"--remote=ws://example"}, {"-pwork"}} {
		command := agents.Command{Path: "/does-not-exist", Args: args}
		if err := PrepareStatus(context.Background(), &command, args, "key", "https://example.test"); err != nil {
			t.Fatal(err)
		}
		if command.Cleanup != nil || !slices.Equal(command.Args, args) {
			t.Fatal("bypass changed command")
		}
	}
	t.Setenv("DARI_CODEX_STATUS", "0")
	command := agents.Command{Path: "/does-not-exist"}
	if err := PrepareStatus(context.Background(), &command, nil, "key", "https://example.test"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DARI_CODEX_STATUS", "")
	bridge, err := newCodexStatusBridge(context.Background(), command, nil, "key", "https://example.test")
	if err != nil {
		t.Fatal(err)
	}
	address := bridge.listener.Addr().String()
	bridge.close()
	bridge.close()
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err == nil {
		_ = conn.Close()
		t.Fatal("bridge still listening")
	}
}

func TestCodexProxyCancellationAndErrors(t *testing.T) {
	canceled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte("unauthorized"))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(canceled)
	}))
	defer upstream.Close()
	bridge, err := newCodexStatusBridge(context.Background(), agents.Command{}, nil, "key", upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.close()
	base := "http://" + bridge.listener.Addr().String()
	request, _ := http.NewRequest(http.MethodGet, base+"/v1/models", nil)
	request.Header.Set("Authorization", "Bearer key")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal(response.StatusCode)
	}
	ctx, cancel := context.WithCancel(context.Background())
	request, _ = http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/responses", strings.NewReader("{}"))
	request.Header.Set("Authorization", "Bearer key")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	_ = response.Body.Close()
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream request not canceled")
	}
}

func TestCodexPrepareComposesCatalogCleanup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	executable := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nprintf 'codex-cli 0.162.1\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	command := agents.Command{Path: executable, Env: os.Environ()}
	previousCleaned := false
	command.Cleanup = func() { previousCleaned = true }
	if err := PrepareStatus(context.Background(), &command, nil, "key", "https://example.test"); err != nil {
		t.Fatal(err)
	}
	if !agents.ArgsContainFlag(command.Args, "--remote") {
		t.Fatal(command.Args)
	}
	command.Cleanup()
	if !previousCleaned {
		t.Fatal("catalog cleanup was lost")
	}
}
