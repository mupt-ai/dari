// Package opencode launches OpenCode with session-local Dari configuration
// and a status plugin. The plugin's server and TUI halves are server.ts and
// tui.tsx, embedded as written.
package opencode

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

//go:embed server.ts
var serverPlugin string

//go:embed tui.tsx
var tuiPlugin string

// OpenCode subcommands that manage local state or the shared background
// service. That service can outlive this launch, so they get none of Dari's
// session-local configuration, temporary plugin, or routing key.
var openCodeManagementCommands = map[string]bool{
	"auth": true, "debug": true, "mcp": true, "plugin": true, "reload": true,
	"service": true, "session": true, "uninstall": true, "update": true, "upgrade": true,
}

// OpenCode subcommands that run their own in-process server, which already
// inherits Dari's environment. Every other invocation connects to the shared
// background service unless it is given --standalone.
var openCodeInProcessServers = map[string]bool{"acp": true, "serve": true}

// openCodeModelCommands accept --model. The interactive TUI does not; it uses
// the configured model instead, which outranks remembered selections.
var openCodeModelCommands = map[string]bool{"mini": true, "run": true}

// openCodeAgents are OpenCode's built-in subagents and small-model tasks.
// Pinning each keeps an agent model set in the user's own configuration from
// bypassing the router. Primary agents stay unpinned so /models can switch
// them; the configured model keeps them on Dari.
var openCodeAgents = []string{"general", "explore", "scout", "title", "summary", "compaction"}

// Configure points OpenCode at the router at baseURL through session-local
// configuration and adds the status plugin.
func Configure(command *agents.Command, baseURL string, models agents.Models) error {
	info := agents.OnlyRequestsInfo(command.Args)
	subcommand := openCodeSubcommand(command.Args)
	if !info && agents.ArgsContainFlag(command.Args, "--server") {
		return errors.New("dari opencode starts a private OpenCode server; remove --server")
	}
	// Pairing always targets the shared background service, which Dari cannot route.
	if !info && subcommand == "pair" {
		return errors.New("dari opencode cannot route paired clients; run `dari opencode serve` and connect to it instead")
	}
	if openCodeManagementCommands[subcommand] {
		command.Env = agents.WithoutEnvironment(command.Env, agents.RoutingAPIKeyEnv)
		return nil
	}
	status, err := agents.StatusEnvironment()
	if err != nil {
		return err
	}
	pluginDirectory, err := writeOpenCodeStatusPlugin()
	if err != nil {
		return err
	}
	config, err := openCodeConfig(baseURL, pluginDirectory, models)
	if err != nil {
		return err
	}
	status["OPENCODE_CONFIG_CONTENT"] = config
	command.Env = agents.WithEnvironment(command.Env, status)
	if info {
		return nil
	}
	if !openCodeInProcessServers[subcommand] && !agents.ArgsContainFlag(command.Args, "--standalone") {
		command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--standalone"})
	}
	if openCodeModelCommands[subcommand] {
		// Keep a Dari model the user chose; anything else would bypass the router.
		if !offered(models, flagValue(command.Args, "--model")) {
			command.Args = replaceFlag(command.Args, "--model", []string{"--model", models.Default()})
		}
	}
	return nil
}

// openCodeValueFlags are OpenCode flags whose value is a separate argument, so
// it is not mistaken for the subcommand.
var openCodeValueFlags = map[string]bool{
	"--agent": true, "--completions": true, "--log-level": true, "--model": true, "-m": true,
	"--prompt": true, "--server": true, "--session": true, "-s": true,
}

// openCodeSubcommand returns the first positional argument, skipping leading
// flags such as `--print-logs` that OpenCode accepts before the subcommand.
func openCodeSubcommand(args []string) string {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return ""
		}
		if !strings.HasPrefix(arg, "-") {
			return arg
		}
		if openCodeValueFlags[arg] {
			i++
		}
	}
	return ""
}

func replaceFlag(args []string, flag string, value []string) []string {
	result := make([]string, 0, len(args)+len(value))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			result = append(result, args[i:]...)
			break
		}
		if arg == flag || flag == "--model" && arg == "-m" {
			i++
			continue
		}
		if strings.HasPrefix(arg, flag+"=") || flag == "--model" && strings.HasPrefix(arg, "-m=") {
			continue
		}
		result = append(result, arg)
	}
	return agents.InsertBeforeDoubleDash(result, value)
}

func flagValue(args []string, flag string) string {
	for i, arg := range args {
		if arg == "--" {
			break
		}
		if (arg == flag || flag == "--model" && arg == "-m") && i+1 < len(args) {
			return args[i+1]
		}
		if value, ok := strings.CutPrefix(arg, flag+"="); ok {
			return value
		}
	}
	return ""
}

func offered(models agents.Models, model string) bool {
	for _, candidate := range models.Menu() {
		if candidate == model {
			return true
		}
	}
	return false
}

func openCodeConfig(baseURL, pluginDirectory string, models agents.Models) (string, error) {
	defaultModel := models.Default()
	pinned := make(map[string]any, len(openCodeAgents))
	for _, name := range openCodeAgents {
		pinned[name] = map[string]string{"model": defaultModel}
	}
	// Keys follow the provider name, so OpenCode's "dari/<key>" reference is
	// the same id the router accepts.
	offeredModels := map[string]any{}
	for _, model := range models.Menu() {
		name := strings.TrimPrefix(model, agents.ExplicitModelPrefix)
		if model == agents.RoutingModel {
			name = "Dari Router"
		}
		entry := map[string]any{
			"id":         model,
			"name":       name,
			"attachment": true,
			"reasoning":  model != agents.RoutingModel,
			"tool_call":  true,
			"limit":      map[string]int{"context": 1_000_000, "output": 128_000},
			"modalities": map[string][]string{"input": {"text", "image"}, "output": {"text"}},
		}
		if model != agents.RoutingModel {
			variants := map[string]any{}
			for _, effort := range []string{"low", "medium", "high"} {
				variants[effort] = map[string]string{"reasoningEffort": effort}
			}
			entry["variants"] = variants
		}
		offeredModels[strings.TrimPrefix(model, "dari/")] = entry
	}
	body, err := json.Marshal(map[string]any{
		"model":       defaultModel,
		"small_model": defaultModel,
		"agent":       pinned,
		"plugins":     []string{pluginDirectory},
		// /models lists only the router's models, not other configured providers.
		"enabled_providers": []string{"dari"},
		"provider": map[string]any{
			"dari": map[string]any{
				"npm":  "@ai-sdk/openai-compatible",
				"name": "Dari",
				"env":  []string{agents.RoutingAPIKeyEnv},
				"options": map[string]string{
					"baseURL": baseURL + "/v1",
					"apiKey":  "{env:" + agents.RoutingAPIKeyEnv + "}",
				},
				"models": offeredModels,
			},
		},
	})
	if err != nil {
		return "", fmt.Errorf("encode OpenCode config: %w", err)
	}
	return string(body), nil
}

// writeOpenCodeStatusPlugin writes the status plugin into Dari's cache and
// returns the plugin directory OpenCode loads it from.
func writeOpenCodeStatusPlugin() (string, error) {
	files := map[string]string{
		"server.ts": serverPlugin,
		"tui.tsx":   tuiPlugin,
	}
	var directory string
	for name, content := range files {
		path, err := agents.WriteCacheFile("opencode/plugin/"+name, content)
		if err != nil {
			return "", fmt.Errorf("write OpenCode plugin: %w", err)
		}
		directory = filepath.Dir(path)
	}
	return directory, nil
}
