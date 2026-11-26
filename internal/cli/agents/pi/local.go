package pi

import (
	_ "embed"
	"encoding/json"
	"os"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

//go:embed local.ts
var localExtension string

// LocalCommand registers only this session's engine and advertised context size.
func LocalCommand(path string, args []string, id, base string, window int) (agents.Command, error) {
	var zero agents.Command
	config, err := json.Marshal(map[string]any{"id": id, "contextWindow": window, "baseUrl": base})
	if err != nil {
		return zero, err
	}
	extension, err := agents.WriteCacheFile("pi/local-provider.ts", localExtension)
	if err != nil {
		return zero, err
	}
	flags := []string{"--extension", extension, "--provider", "dari-metal", "--model", id, "--models", "dari-metal/" + id}
	return agents.Command{
		Path: path, Args: append(flags, args...),
		Env: agents.WithEnvironment(os.Environ(), map[string]string{"DARI_PI_ENGINE": string(config), "PI_OFFLINE": "1"}),
	}, nil
}
