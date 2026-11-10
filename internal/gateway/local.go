package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/mupt-ai/dari/internal/selfupdate"
)

const (
	// LocalPort is where a local gateway listens, on loopback only.
	LocalPort = 7340

	binaryName = "dari-gateway"
)

// LocalURL is a local gateway's base URL.
func LocalURL() string {
	return "http://127.0.0.1:" + strconv.Itoa(LocalPort)
}

// launchedAgentEnv are variables a Dari launch sets for Claude Code to reach
// Dari, which the gateway would read as Anthropic credentials.
var launchedAgentEnv = []string{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"}

type localPaths struct {
	binary, db, config, log, pid string
}

func paths() (localPaths, error) {
	dir, err := Dir()
	if err != nil {
		return localPaths{}, err
	}
	return localPaths{
		binary: filepath.Join(dir, "bin", binaryName),
		db:     filepath.Join(dir, "gateway.db"),
		config: filepath.Join(dir, "config.json"),
		log:    filepath.Join(dir, "gateway.log"),
		pid:    filepath.Join(dir, "gateway.pid"),
	}, nil
}

// ConfigPath is the router config a local gateway serves when it exists;
// without it the gateway serves its default router.
func ConfigPath() (string, error) {
	p, err := paths()
	return p.config, err
}

// LogPath is where a local gateway started in the background logs.
func LogPath() (string, error) {
	p, err := paths()
	return p.log, err
}

// Install downloads the gateway for this machine from the CLI's own release,
// so the two always match, and returns its version. Unreleased builds take
// the latest release.
func Install(ctx context.Context, cliVersion string) (string, error) {
	p, err := paths()
	if err != nil {
		return "", err
	}
	return selfupdate.Install(ctx, cliVersion, gatewayReleaseURL(cliVersion), binaryName, p.binary)
}

func gatewayReleaseURL(cliVersion string) string {
	if !selfupdate.IsReleaseVersion(cliVersion) {
		return selfupdate.ReleasesURL + "/latest"
	}
	return selfupdate.ReleasesURL + "/tags/v" + strings.TrimPrefix(cliVersion, "v")
}

// EnsureInstalled installs the gateway when it is missing.
func EnsureInstalled(ctx context.Context, cliVersion string, progress func(string)) error {
	p, err := paths()
	if err != nil {
		return err
	}
	if _, err := os.Stat(p.binary); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	progress("Installing Dari Gateway")
	version, err := Install(ctx, cliVersion)
	if err != nil {
		return fmt.Errorf("install Dari Gateway: %w", err)
	}
	progress("Dari Gateway " + version + " installed")
	return nil
}

// EffectiveConfig is the router config the local gateway serves, as JSON:
// its config file when one exists, else the gateway's built-in default.
func EffectiveConfig(ctx context.Context, cliVersion string) ([]byte, error) {
	return printConfig(ctx, cliVersion, "--print-config")
}

// DefaultConfig is the gateway's built-in default router config, as JSON.
func DefaultConfig(ctx context.Context, cliVersion string) ([]byte, error) {
	return printConfig(ctx, cliVersion, "--print-default-config")
}

func printConfig(ctx context.Context, cliVersion, flag string) ([]byte, error) {
	if err := EnsureInstalled(ctx, cliVersion, func(string) {}); err != nil {
		return nil, err
	}
	cmd, err := Command(Settings{LocalKey: "unused"}, nil)
	if err != nil {
		return nil, err
	}
	cmd.Args = append(cmd.Args, flag)
	cmd.Stdout, cmd.Stderr = nil, nil
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return nil, fmt.Errorf("read the gateway config: %s", strings.TrimSpace(string(exitErr.Stderr)))
		}
		return nil, err
	}
	return out, nil
}

// Healthy reports whether a gateway answers at the local URL.
func Healthy(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, LocalURL()+"/v1/models", nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return true
}

// EnsureRunning starts the local gateway in the background unless one is
// already answering, installing it first when it is missing. progress
// receives one line per step taken.
func EnsureRunning(ctx context.Context, settings Settings, cliVersion string, progress func(string)) error {
	if Healthy(ctx) {
		return nil
	}
	p, err := paths()
	if err != nil {
		return err
	}
	if err := EnsureInstalled(ctx, cliVersion, progress); err != nil {
		return err
	}
	if err := Start(settings); err != nil {
		return err
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if Healthy(ctx) {
			progress("Local gateway running at " + LocalURL())
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return fmt.Errorf("the local gateway did not start; see %s", p.log)
}

// Command returns the local gateway process for settings, logging to out.
func Command(settings Settings, out io.Writer) (*exec.Cmd, error) {
	p, err := paths()
	if err != nil {
		return nil, err
	}
	if settings.LocalKey == "" {
		return nil, errors.New("the local gateway has no key; run `dari gateway setup`")
	}
	env := map[string]string{
		"DARI_GATEWAY_KEYS": settings.LocalKey,
		"DARI_GATEWAY_DB":   p.db,
		"DARI_GATEWAY_HOST": "127.0.0.1",
		"PORT":              strconv.Itoa(LocalPort),
	}
	if _, err := os.Stat(p.config); err == nil {
		env["DARI_GATEWAY_CONFIG"] = p.config
	}
	if settings.AutoRoutingKey != "" {
		env["DARI_AUTO_ROUTING_API_KEY"] = settings.AutoRoutingKey
	}
	for name, value := range settings.ProviderKeys {
		env[name] = value
	}
	cmd := exec.Command(p.binary)
	// Provider API keys come from the environment the gateway starts in. A
	// shell inside a Dari-launched agent also carries the agent's routing
	// variables, which point at Dari rather than the provider.
	insideLaunch := os.Getenv("DARI_ROUTING_API_KEY_FROM_LAUNCH") != ""
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if _, set := env[name]; set || name == "DARI_GATEWAY_CONFIG" || name == "DARI_AUTO_ROUTING_API_KEY" {
			continue
		}
		if insideLaunch && slices.Contains(launchedAgentEnv, name) {
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	for name, value := range env {
		cmd.Env = append(cmd.Env, name+"="+value)
	}
	// The gateway's own directory, so a dari-gateway.yaml in the user's
	// working directory is never picked up.
	cmd.Dir = filepath.Dir(p.db)
	cmd.Stdout = out
	cmd.Stderr = out
	return cmd, nil
}

// Start runs the local gateway in the background, detached from this process.
func Start(settings Settings) error {
	p, err := paths()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p.log), 0o700); err != nil {
		return err
	}
	log, err := os.OpenFile(p.log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd, err := Command(settings, log)
	if err != nil {
		return err
	}
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start the local gateway: %w", err)
	}
	if err := os.WriteFile(p.pid, []byte(strconv.Itoa(cmd.Process.Pid)), 0o600); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// Stop stops a local gateway started in the background. It reports whether
// one was running.
func Stop(ctx context.Context) (bool, error) {
	p, err := paths()
	if err != nil {
		return false, err
	}
	raw, err := os.ReadFile(p.pid)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	// Liveness comes from the process table, not the HTTP probe: a gateway
	// still starting, or slow to answer, is running and must be stopped. A
	// pid that is gone, or now belongs to another program, is stale.
	if err != nil || !gatewayRunning(pid, p.binary) {
		_ = os.Remove(p.pid)
		return false, nil
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false, err
	}
	// Ask it to stop, then force it; report success only once it has exited,
	// so a restart never mistakes the old process for the new one.
	for _, signal := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		if err := process.Signal(signal); err != nil && gatewayRunning(pid, p.binary) {
			return false, fmt.Errorf("stop the local gateway (pid %d): %w", pid, err)
		}
		if waitForExit(ctx, pid, p.binary, 5*time.Second) {
			_ = os.Remove(p.pid)
			return true, nil
		}
	}
	return false, fmt.Errorf("the local gateway (pid %d) did not exit", pid)
}

// gatewayRunning reports whether pid is a live process running binary. A
// zombie counts as exited: it holds no port and serves nothing.
func gatewayRunning(pid int, binary string) bool {
	out, err := exec.Command("ps", "-o", "stat=,command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	stat, command, _ := strings.Cut(strings.TrimSpace(string(out)), " ")
	return !strings.HasPrefix(stat, "Z") && strings.Contains(command, binary)
}

func waitForExit(ctx context.Context, pid int, binary string, timeout time.Duration) bool {
	for deadline := time.Now().Add(timeout); time.Now().Before(deadline); {
		if !gatewayRunning(pid, binary) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(100 * time.Millisecond):
		}
	}
	return !gatewayRunning(pid, binary)
}

// Restart restarts the local gateway so it serves current settings and
// config. A gateway that was not running stays stopped.
func Restart(ctx context.Context, settings Settings, cliVersion string) error {
	stopped, err := Stop(ctx)
	if err != nil {
		return err
	}
	if !stopped {
		// Something this CLI did not start in the background, such as
		// `dari gateway serve`, holds the port and would keep the old config.
		if Healthy(ctx) {
			return fmt.Errorf("a gateway this CLI did not start is answering at %s; restart it to apply the change", LocalURL())
		}
		return nil
	}
	return EnsureRunning(ctx, settings, cliVersion, func(string) {})
}

// CanonicalModels is the model ids Dari serves, which the local model picker
// offers, as JSON.
func CanonicalModels(ctx context.Context, cliVersion string) ([]byte, error) {
	return printConfig(ctx, cliVersion, "--print-canonical-models")
}
