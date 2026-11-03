// Package pi launches Pi with a Dari provider extension that shows routing
// status in Pi's footer. The extension is extension.ts, embedded as written.
package pi

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mupt-ai/dari-cli/internal/cli/agents"
)

//go:embed extension.ts
var extension string

// baseURLEnv carries the router's base URL, without /v1, to the extension.
const baseURLEnv = "DARI_ROUTING_BASE_URL"

// Configure adds the Dari provider extension, which offers the launch's
// models in Pi's model picker, and starts on the default model. The provider
// calls the router at baseURL.
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
	extensionPath, err := agents.WriteCacheFile("pi/provider.ts", extension)
	if err != nil {
		return fmt.Errorf("write Pi provider: %w", err)
	}
	command.Env = agents.WithEnvironment(command.Env, status)
	args := []string{
		"--extension", extensionPath,
		"--provider", "dari",
		"--model", models.Default(),
	}
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
