package codex

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// codexStatusBridge owns one launcher session. Its HTTP proxy captures routing
// headers; its app-server proxy sends display-only names to the TUI. It never
// sends thread/name/set to Codex, so saved names and resume lists stay intact.
type codexStatusBridge struct {
	ctx              context.Context
	cancel           context.CancelFunc
	server           *http.Server
	listener         net.Listener
	transport        *http.Transport
	command          agents.Command
	serverArgs       []string
	directory        string
	backendMu        sync.Mutex
	backendURL       string
	backendTokenPath string
	backendDone      chan struct{}
	token            string
	mu               sync.Mutex
	session          *codexDisplaySession
	used             bool
	handlers         sync.WaitGroup
	serveDone        chan struct{}
}

func PrepareStatus(ctx context.Context, command *agents.Command, launchArgs []string, key string, baseURL string) error {
	if !codexInteractiveArgs(launchArgs) || os.Getenv("DARI_CODEX_STATUS") == "0" {
		return nil
	}
	// Profiles currently aren't forwarded by Codex's standalone app-server.
	// Leave those launches untouched rather than silently changing their config.
	if codexCustomConnection(launchArgs) {
		return nil
	}
	versionCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	versionCommand := exec.CommandContext(versionCtx, command.Path, "--version")
	versionCommand.Env = command.Env
	version, err := versionCommand.Output()
	if err != nil {
		return fmt.Errorf("check Codex status support: %w", err)
	}
	if !codexSupportsStatusBridge(string(version)) {
		return fmt.Errorf("Codex routing status requires Codex 0.162.1 or newer; run codex update or set DARI_CODEX_STATUS=0")
	}
	bridge, err := newCodexStatusBridge(ctx, *command, launchArgs, key, baseURL)
	if err != nil {
		return err
	}
	previousCleanup := command.Cleanup
	command.Cleanup = func() {
		bridge.close()
		if previousCleanup != nil {
			previousCleanup()
		}
	}
	address := "http://" + bridge.listener.Addr().String()
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{
		"--config", "model_providers.dari.base_url=" + strconv.Quote(address+"/v1"),
		"--config", `tui.status_line=["thread-name","context-remaining"]`,
		"--remote", "ws://" + bridge.listener.Addr().String(),
		"--remote-auth-token-env", "DARI_CODEX_BRIDGE_TOKEN",
	})
	command.Env = agents.WithEnvironment(command.Env, map[string]string{"DARI_CODEX_BRIDGE_TOKEN": bridge.token})
	return nil
}

func newCodexStatusBridge(ctx context.Context, command agents.Command, args []string, key, baseURL string) (*codexStatusBridge, error) {
	target, err := url.Parse(baseURL)
	if err != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
		return nil, fmt.Errorf("invalid Codex routing endpoint")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen for Codex status bridge: %w", err)
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		_ = listener.Close()
		return nil, err
	}
	token := hex.EncodeToString(secret)
	ctx, cancel := context.WithCancel(ctx)
	bridge := &codexStatusBridge{
		ctx: ctx, cancel: cancel, listener: listener, command: command,
		token:     token,
		transport: http.DefaultTransport.(*http.Transport).Clone(),
		serveDone: make(chan struct{}),
	}
	bridge.serverArgs, bridge.directory = codexServerOptions(args)
	// Use all effective config overrides, including Dari's temporary catalog.
	bridge.serverArgs, _ = codexServerOptions(command.Args)
	localBase := "http://" + listener.Addr().String() + "/v1"
	bridge.serverArgs = append(bridge.serverArgs,
		"--config", "model_providers.dari.base_url="+strconv.Quote(localBase),
	)
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.Out.URL.Path = request.In.URL.Path
			request.Out.URL.RawPath = ""
			request.SetURL(target)
			request.Out.Host = target.Host
			request.Out.Header.Set("Authorization", "Bearer "+key)
		},
		Transport:      bridge.transport,
		FlushInterval:  -1,
		ModifyResponse: bridge.observeRoutingResponse,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "Dari routing upstream unavailable", http.StatusBadGateway)
		},
	}
	bridge.server = &http.Server{
		ReadHeaderTimeout: 10 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/" {
				bridge.serveAppServer(w, r)
				return
			}
			if r.Header.Get("Authorization") != "Bearer "+key {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			if !strings.HasPrefix(r.URL.Path, "/v1/") {
				http.NotFound(w, r)
				return
			}
			if websocket.IsWebSocketUpgrade(r) {
				// Dari's Responses surface is HTTP/SSE. Preserve Codex's HTTP fallback.
				w.WriteHeader(http.StatusUpgradeRequired)
				return
			}
			proxy.ServeHTTP(w, r)
		}),
	}
	go func() {
		defer close(bridge.serveDone)
		_ = bridge.server.Serve(listener)
	}()
	return bridge, nil
}

func (b *codexStatusBridge) observeRoutingResponse(response *http.Response) error {
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil
	}
	request := response.Request
	if request.Method != http.MethodPost || !strings.HasSuffix(request.URL.Path, "/responses") {
		return nil
	}
	status := agents.StatusFromHeaders(response.Header)
	if status.String() == "" {
		return nil
	}
	var metadata struct {
		ThreadID    string `json:"thread_id"`
		RequestKind string `json:"request_kind"`
	}
	if raw := request.Header.Get("x-codex-turn-metadata"); raw != "" {
		if json.Unmarshal([]byte(raw), &metadata) != nil {
			return nil
		}
	}
	threadID := request.Header.Get("thread-id")
	if threadID == "" {
		threadID = metadata.ThreadID
	}
	if threadID == "" || (metadata.ThreadID != "" && threadID != metadata.ThreadID) {
		return nil
	}
	// Auxiliary work must not overwrite the primary turn's status.
	if metadata.RequestKind != "" && metadata.RequestKind != "turn" {
		return nil
	}
	b.mu.Lock()
	session := b.session
	b.mu.Unlock()
	if session != nil {
		session.update(threadID, status)
	}
	return nil
}

func (b *codexStatusBridge) close() {
	b.cancel()
	_ = b.server.Close()
	<-b.serveDone
	b.mu.Lock()
	session := b.session
	b.mu.Unlock()
	if session != nil {
		session.close()
	}
	b.handlers.Wait()
	b.backendMu.Lock()
	if b.backendDone != nil {
		<-b.backendDone
	}
	if b.backendTokenPath != "" {
		_ = os.Remove(b.backendTokenPath)
	}
	b.backendMu.Unlock()
	b.transport.CloseIdleConnections()
}

// Only TUI launches need a display bridge. Avoid interpreting flag values as
// subcommands or forwarding TUI-only options into app-server.
func codexInteractiveArgs(args []string) bool {
	valueFlags := map[string]bool{
		"-c": true, "--config": true, "-m": true, "--model": true, "-p": true, "--profile": true,
		"-C": true, "--cd": true, "-s": true, "--sandbox": true, "-a": true, "--ask-for-approval": true,
		"--enable": true, "--disable": true, "-i": true, "--image": true, "--add-dir": true,
		"--remote": true, "--remote-auth-token-env": true,
	}
	subcommands := map[string]bool{
		"exec": true, "e": true, "review": true, "login": true, "logout": true, "mcp": true, "plugin": true,
		"app-server": true, "remote-control": true, "app": true, "completion": true, "update": true,
		"doctor": true, "sandbox": true, "debug": true, "apply": true, "a": true, "queue": true,
		"archive": true, "delete": true, "migrate-rollouts": true, "unarchive": true, "cloud": true,
		"exec-server": true, "features": true, "help": true, "agents": true,
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return true
		}
		if valueFlags[arg] {
			i++
			continue
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		return !subcommands[arg]
	}
	return true
}

func codexServerOptions(args []string) ([]string, string) {
	options := []string{"app-server"}
	directory := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		name, value, assigned := strings.Cut(arg, "=")
		if strings.HasPrefix(arg, "-c") && !strings.HasPrefix(arg, "--") && len(arg) > 2 {
			name, value, assigned = "-c", arg[2:], true
		}
		switch name {
		case "-c", "--config", "--enable", "--disable", "-C", "--cd":
			if !assigned {
				if i+1 >= len(args) {
					continue
				}
				i++
				value = args[i]
			}
			if name == "-C" || name == "--cd" {
				directory = value
			} else {
				options = append(options, name, value)
			}
		case "--strict-config":
			options = append(options, arg)
		}
	}
	return options, directory
}

func codexCustomConnection(args []string) bool {
	for _, arg := range args {
		if arg == "--" {
			break
		}
		name, _, _ := strings.Cut(arg, "=")
		if name == "--remote" || name == "--profile" || strings.HasPrefix(arg, "-p") {
			return true
		}
	}
	return false
}

func codexSupportsStatusBridge(version string) bool {
	var major, minor, patch int
	if _, err := fmt.Sscanf(strings.TrimSpace(version), "codex-cli %d.%d.%d", &major, &minor, &patch); err != nil {
		return false
	}
	return major > 0 || minor > 162 || (minor == 162 && patch >= 1)
}
