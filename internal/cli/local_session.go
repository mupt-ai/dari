package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// A session owns its private directory and only the children it starts.
// A pre-existing engine (including an SSH forward) never enters stops.
type localSession struct {
	dir   string
	stops []func()
}

func (s *localSession) close() {
	for i := len(s.stops) - 1; i >= 0; i-- {
		s.stops[i]()
	}
	os.RemoveAll(s.dir)
}
func (s *localSession) config(name string, data any) (string, error) {
	b, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	path := filepath.Join(s.dir, name)
	return path, os.WriteFile(path, b, 0600)
}

// Both services bind port zero and publish the assigned port after startup.
func (s *localSession) start(ctx context.Context, cmd *exec.Cmd, stderr io.Writer) (string, error) {
	ready := filepath.Join(s.dir, fmt.Sprintf("port-%d", len(s.stops)))
	cmd.Env = agents.WithEnvironment(cmd.Env, map[string]string{"DARI_SESSION_PORT_FILE": ready})
	// Keep request logs out of the foreground harness TUI. Only surface a
	// bounded diagnostic if startup fails.
	log, err := os.CreateTemp(s.dir, "startup-*.log")
	if err != nil {
		return "", err
	}
	defer log.Close()
	cmd.Stdout, cmd.Stderr = log, log
	stop, err := agents.StartIsolatedProcess(cmd)
	if err != nil {
		return "", err
	}
	done := make(chan struct{})
	var exit error
	go func() { exit = cmd.Wait(); close(done) }()
	s.stops = append(s.stops, func() { stop(); <-done })
	ticker := time.NewTicker(80 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(3 * time.Minute)
	defer timeout.Stop()
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-timeout.C:
			return "", errStartTimeout
		case <-done:
			if end, err := log.Seek(0, io.SeekEnd); err == nil {
				_, _ = log.Seek(max(0, end-4096), io.SeekStart)
				_, _ = io.CopyN(stderr, log, min(end, 4096))
			}
			return "", fmt.Errorf("%s exited before ready: %v", filepath.Base(cmd.Path), exit)
		case <-ticker.C:
			raw, err := os.ReadFile(ready)
			if err == nil {
				p, err := strconv.Atoi(string(raw))
				if err == nil && p > 0 && p <= 65535 {
					return fmt.Sprintf("http://127.0.0.1:%d", p), nil
				}
			}
		}
	}
}
func localWindow(ctx context.Context, base, model string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", base+"/v1/models", nil)
	if err != nil {
		return 0, err
	}
	client := http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var list struct {
		Data []struct {
			ID     string
			Window int `json:"context_window"`
		}
	}
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("local model discovery: %s", resp.Status)
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 65536)).Decode(&list); err != nil {
		return 0, err
	}
	if len(list.Data) != 1 || list.Data[0].Window <= 0 {
		return 0, errors.New("listener did not advertise a local model and context window")
	}
	if list.Data[0].ID != model {
		return 0, errDifferentModel
	}
	return list.Data[0].Window, nil
}

var (
	errDifferentModel = errors.New("different local model")
	errStartTimeout   = errors.New("timed out waiting for local service")
)

func (s *localSession) engine(ctx context.Context, l agentLaunch, stderr io.Writer) (string, int, error) {
	model := l.localModel
	port := os.Getenv("DARI_INFERENCE_PORT")
	if port == "" {
		port = "8081"
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return "", 0, errors.New("invalid DARI_INFERENCE_PORT")
	}
	base := "http://127.0.0.1:" + strconv.Itoa(p)
	window, err := localWindow(ctx, base, model)
	if err == nil {
		return base, window, nil
	}
	if !errors.Is(err, syscall.ECONNREFUSED) && !errors.Is(err, errDifferentModel) {
		return "", 0, fmt.Errorf("check local listener %s: %w", base, err)
	}
	runtime, err := inferenceRuntime(ctx, cliVersion, stderr, false)
	if err != nil {
		return "", 0, fmt.Errorf("%v; to install: dari pull %s", err, model)
	}
	child := exec.CommandContext(ctx, runtime, "run", model, "--port", "0")
	child.Env = agents.WithEnvironment(os.Environ(), map[string]string{"HF_HUB_OFFLINE": "1"})
	if l.name == "hermes" && os.Getenv("DARI_CONTEXT_LENGTH") == "" {
		child.Args = append(child.Args, "--context-window", "64000")
	}
	base, err = s.start(ctx, child, stderr)
	// Cancelling startup or a slow load says nothing about missing weights.
	if errors.Is(err, context.Canceled) || errors.Is(err, errStartTimeout) {
		return "", 0, err
	}
	if err != nil {
		return "", 0, fmt.Errorf("%w; if the model is missing run dari pull %s", err, model)
	}
	window, err = localWindow(ctx, base, model)
	return base, window, err
}
func runLocalHarness(ctx context.Context, path string, l agentLaunch, in io.Reader, out, stderr io.Writer) int {
	for _, flag := range []string{"--provider", "--model", "--models", "--router", "--base-url", "--server", "--fallback-model"} {
		if agents.ArgsContainFlag(l.args, flag) {
			fmt.Fprintf(stderr, "%s conflicts with --local %s\n", flag, l.localModel)
			return 1
		}
	}
	dir, err := os.MkdirTemp("", "dari-local-")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	s := localSession{dir: dir}
	defer s.close()
	// Until the foreground harness exists, Ctrl-C means cancel startup.
	// Keep the child context alive on handoff: the engine belongs to it.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	interruptHandled := make(chan struct{})
	go func() {
		defer close(interruptHandled)
		if _, interrupted := <-interrupts; interrupted {
			cancel()
		}
	}()
	finishStartup := sync.OnceFunc(func() {
		signal.Stop(interrupts)
		close(interrupts)
		<-interruptHandled
	})
	defer finishStartup()
	base, window, err := s.engine(ctx, l, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	cmd, err := s.harness(ctx, path, l, base, window, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if cmd.Cleanup != nil {
		defer cmd.Cleanup()
	}
	cmd.Cleanup = s.close // prevent exec replacement: retain session ownership
	finishStartup()
	if ctx.Err() != nil {
		return 1
	}
	fmt.Fprintf(stderr, "%s is using local %s (%d tokens).\n", l.name, l.localModel, window)
	return executeAgentCommand(ctx, l.name, cmd, in, out, stderr)
}
