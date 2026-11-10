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

// inheritedEnv are the only variables a local gateway takes from the shell
// that starts it: what a process needs to run and reach the network. Provider
// credentials are never among them, so a key exported in the shell for some
// other tool is never billed; the local gateway serves only the keys saved in
// its settings and its connected subscriptions. Names are matched
// case-insensitively, as Windows treats them.
var inheritedEnv = []string{
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TZ",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
	"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
	"DARI_AUTO_ROUTING_URL",
}

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
	version, err := selfupdate.Install(ctx, cliVersion, gatewayReleaseURL(cliVersion), binaryName, p.binary)
	if err != nil {
		return "", err
	}
	// Recorded so a CLI on another version knows to replace it.
	if err := os.WriteFile(versionPath(p), []byte(bareVersion(version)), 0o600); err != nil {
		return "", err
	}
	return version, nil
}

// InstalledVersion is the version of the installed gateway, "" when unknown
// (installed before versions were recorded, or not installed).
func InstalledVersion() string {
	p, err := paths()
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(versionPath(p))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func versionPath(p localPaths) string {
	return p.binary + ".version"
}

func bareVersion(version string) string {
	return strings.TrimPrefix(strings.TrimSpace(version), "v")
}

// releasesURL lists the releases the gateway installs from.
var releasesURL = selfupdate.ReleasesURL

func gatewayReleaseURL(cliVersion string) string {
	if !selfupdate.IsReleaseVersion(cliVersion) {
		return releasesURL + "/latest"
	}
	return releasesURL + "/tags/v" + strings.TrimPrefix(cliVersion, "v")
}

// EnsureInstalled installs the gateway when it is missing.
func EnsureInstalled(ctx context.Context, cliVersion string, progress func(string)) error {
	_, err := ensureInstalled(ctx, cliVersion, progress)
	return err
}

// ensureInstalled installs the gateway when it is missing, and replaces it
// when a released CLI finds it on another version, so `dari update` updates
// both. It reports whether it replaced an installed gateway. A failed update
// keeps the installed gateway rather than failing the launch.
func ensureInstalled(ctx context.Context, cliVersion string, progress func(string)) (bool, error) {
	p, err := paths()
	if err != nil {
		return false, err
	}
	if _, err := os.Stat(p.binary); errors.Is(err, os.ErrNotExist) {
		progress("Installing Dari Gateway")
		version, err := Install(ctx, cliVersion)
		if err != nil {
			return false, fmt.Errorf("install Dari Gateway: %w", err)
		}
		progress("Dari Gateway " + version + " installed")
		return false, nil
	} else if err != nil {
		return false, err
	}
	if !selfupdate.IsReleaseVersion(cliVersion) || InstalledVersion() == bareVersion(cliVersion) {
		return false, nil
	}
	progress("Updating Dari Gateway to v" + bareVersion(cliVersion))
	version, err := Install(ctx, cliVersion)
	if err != nil {
		progress("Could not update Dari Gateway (" + err.Error() + "); using the installed one")
		return false, nil
	}
	progress("Dari Gateway " + version + " installed")
	return true, nil
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
	p, err := paths()
	if err != nil {
		return err
	}
	if _, err := ensureInstalled(ctx, cliVersion, progress); err != nil {
		return err
	}
	if Healthy(ctx) {
		// The installed binary may be newer than the running process: an
		// update here, or an earlier command that installed without
		// restarting. Restart the gateway this CLI runs on it.
		installed := InstalledVersion()
		if !runsOldBinary(installed, RunningVersion()) {
			return nil
		}
		stopped, err := Stop(ctx)
		if err != nil {
			return err
		}
		if !stopped && Healthy(ctx) {
			progress("A gateway this CLI did not start is answering at " + LocalURL() + "; restart it to use Dari Gateway v" + installed)
			return nil
		}
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
	cmd.Env = []string{}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if slices.Contains(inheritedEnv, strings.ToUpper(name)) {
			cmd.Env = append(cmd.Env, entry)
		}
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
	if err := MarkRunning(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// runsOldBinary reports whether the serving gateway is older than the
// installed binary: running records another version, or none (started before
// versions were recorded). Nothing is compared while the installed version is
// unknown.
func runsOldBinary(installed, running string) bool {
	return installed != "" && running != installed
}

// MarkRunning records that a gateway on the installed version is serving, so
// a later launch can tell when the installed binary has moved past it.
func MarkRunning() error {
	p, err := paths()
	if err != nil {
		return err
	}
	return os.WriteFile(runningVersionPath(p), []byte(InstalledVersion()), 0o600)
}

// ClearRunning forgets the serving gateway's version once it has stopped.
func ClearRunning() {
	if p, err := paths(); err == nil {
		_ = os.Remove(runningVersionPath(p))
	}
}

// RunningVersion is the version of the gateway serving now, as recorded when
// this CLI started it, or "" when unknown.
func RunningVersion() string {
	p, err := paths()
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(runningVersionPath(p))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func runningVersionPath(p localPaths) string {
	return p.pid + ".version"
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
		ClearRunning()
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
			ClearRunning()
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
