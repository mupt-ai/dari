// Package pi launches Pi with a Dari provider extension that shows routing
// status in Pi's footer. The extension is extension.ts, embedded as written.
package pi

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

//go:embed extension.ts
var extension string

// baseURLEnv carries the router's base URL, without /v1, to the extension.
const baseURLEnv = "DARI_ROUTING_BASE_URL"

// Configure points the Dari provider extension (installed by Setup) at the
// router at baseURL for this launch, offers the launch's models in Pi's model
// picker, and starts on the default model.
func Configure(command *agents.Command, baseURL string, models agents.Models) error {
	status, err := agents.StatusEnvironment()
	if err != nil {
		return err
	}
	menu, err := json.Marshal(models.Menu())
	if err != nil {
		return fmt.Errorf("encode Pi models: %w", err)
	}
	status["DARI_MODELS"] = string(menu)
	status[baseURLEnv] = baseURL
	command.Env = agents.WithEnvironment(command.Env, status)
	args := []string{"--provider", "dari"}
	// Pi loads the provider extension Setup installed on its own. A launch
	// without it (setup skipped or failed, or an older copy) brings its own.
	if !installed() {
		extensionPath, err := agents.WriteCacheFile("pi/provider.ts", extension)
		if err != nil {
			return fmt.Errorf("write Pi provider: %w", err)
		}
		args = append([]string{"--extension", extensionPath}, args...)
	}
	args = append(args, "--model", models.Default())
	// Scoping the router's models makes /model open on them rather than on
	// every provider the user has signed in to.
	if !agents.ArgsContainFlag(command.Args, "--models") {
		scoped := make([]string, 0, len(models.Menu()))
		for _, model := range models.Menu() {
			scoped = append(scoped, "dari/"+model)
		}
		args = append(args, "--models", strings.Join(scoped, ","))
	}
	command.Args = agents.InsertBeforeDoubleDash(command.Args, args)
	return nil
}

// installed reports whether Pi's extensions directory has this provider
// extension, as Setup installs it.
func installed() bool {
	dir, err := AgentDir()
	if err != nil {
		return false
	}
	content, err := os.ReadFile(filepath.Join(dir, "extensions", extensionFile))
	return err == nil && string(content) == extension
}
