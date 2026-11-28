package codex

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// Agent is Codex. Its app reads the CLI's own config.
var Agent = agents.Agent{
	Name:             "codex",
	Label:            "Codex",
	Help:             "Launch Codex through Dari; forward all following arguments (`dari setup codex` for setup)",
	CodingAgent:      "codex",
	Suggestion:       "codex",
	Subscriptions:    []string{"openai_codex"},
	RouterKey:        "dari-cli:codex",
	SessionEnv:       "CODEX_THREAD_ID",
	HandlesInterrupt: true,
	Configure: func(command *agents.Command, _, baseURL string, models agents.Models, _ bool) error {
		Configure(command, baseURL, models)
		return nil
	},
	Prepare: func(ctx context.Context, command *agents.Command, args []string, key, baseURL string, models agents.Models) error {
		if err := PrepareCatalog(ctx, command, key, baseURL, models); err != nil {
			return err
		}
		return PrepareStatus(ctx, command, args, key, baseURL)
	},
	SavedModel: func() string {
		home, err := Home()
		if err != nil {
			return ""
		}
		return SavedModel(home)
	},
	Setup: &agents.Setup{
		Applies:        "new Codex sessions pick it up",
		Desktop:        "the Codex app",
		DesktopApplies: "restart the Codex app to apply it there",
		SharedConfig:   true,
		IsSetUp: func(context.Context) (bool, bool) {
			home, err := Home()
			return err == nil && IsSetUp(home), false
		},
		Save: save,
		Remove: func(context.Context) (bool, error) {
			home, err := Home()
			if err != nil {
				return false, err
			}
			return RemoveSetup(home)
		},
	},
	Local: local,
	Traces: &agents.Traces{
		Path: func() (string, error) {
			home, err := Home()
			return filepath.Join(home, "sessions"), err
		},
		Sessions: agents.TranscriptFiles(parseCodexRollout, "rollout-*.jsonl"),
	},
}

// save writes Dari into config.toml, which Codex's app and CLI both read.
func save(ctx context.Context, key, baseURL string, models agents.Models) error {
	home, err := Home()
	if err != nil {
		return err
	}
	catalog, disableWebSearch, err := Catalog(ctx, key, baseURL, models)
	if err != nil {
		return err
	}
	// A router that serves Codex its own list is named instead of copied,
	// so Codex follows its models; an older one gets the copy, as before.
	// A failed check changes nothing: falling back to a copy would stop a
	// live setup following the router over a passing network error.
	catalogURL := ""
	if mayReadLiveCatalog(ctx, home) {
		catalogURL, err = LiveCatalogURL(ctx, key, baseURL, models.Default())
		if err != nil {
			return err
		}
	}
	return Setup(home, baseURL, key, models.Default(), catalog, catalogURL, disableWebSearch, models.RemoteCompaction)
}

// Version is what `codex --version` prints for the Codex on PATH, "" when
// there is none, or an error when it could not be run. Tests replace it.
var Version = func(ctx context.Context) (string, error) {
	executable, err := agents.Executable("codex")
	if err != nil {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, executable, "--version").Output()
	if err != nil {
		return "", fmt.Errorf("run %s --version: %w", executable, err)
	}
	return strings.TrimSpace(string(out)), nil
}

// mayReadLiveCatalog reports whether setup may point Codex at the
// router's list: the Codex on PATH, if any, must read model_catalog_url (an
// older one shows OpenAI's models instead). Without one on PATH, only the
// Codex app reads the config, and its own Codex is new enough. When the
// version cannot be read, the setup keeps what it has, so a passing failure
// never turns a live setup back into a copy.
func mayReadLiveCatalog(ctx context.Context, home string) bool {
	version, err := Version(ctx)
	switch {
	case err != nil:
		return ReadsLiveCatalog(home)
	case version == "":
		return true
	default:
		return ReadsLiveCatalogVersion(version)
	}
}

// local runs Codex on the local model through the bridge, which speaks the
// Responses API.
func local(ctx context.Context, command agents.Command, local agents.Local) (agents.Command, error) {
	url, key, err := local.Bridge()
	if err != nil {
		return command, err
	}
	models := agents.Models{Enabled: []string{"local/" + local.Model}, ContextWindow: local.Window}
	Configure(&command, url, models)
	if err := PrepareCatalog(ctx, &command, key, url, models); err != nil {
		return command, err
	}
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"-c", `web_search="disabled"`, "-c", "model_context_window=" + strconv.Itoa(local.Window)})
	command.Env = agents.WithEnvironment(command.Env, map[string]string{agents.RoutingAPIKeyEnv: key})
	return command, nil
}
