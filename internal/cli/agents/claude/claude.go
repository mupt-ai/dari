// Package claude launches Claude Code through Dari and renders its status
// line from the session transcript.
package claude

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// routingEnvironment points Claude Code at the router at baseURL: what a
// launch sets for its session, and what setup writes into Claude Code's
// settings so `claude` itself routes the same way.
func routingEnvironment(key, baseURL string, models agents.Models) map[string]string {
	return map[string]string{
		"ANTHROPIC_BASE_URL":               baseURL,
		"ANTHROPIC_AUTH_TOKEN":             key,
		"ANTHROPIC_API_KEY":                "",
		"CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1",
		"CLAUDE_CODE_MAX_CONTEXT_TOKENS":   "1000000",
		// Subagents and aliases resolve to the stable model, not the /model
		// pick: these pins are fixed for the session and written to settings,
		// so a pick they followed would go stale the moment the user switched.
		// Haiku stays native: Dari serves background work on its cheapest model.
		"CLAUDE_CODE_SUBAGENT_MODEL":     models.Stable(),
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   models.Stable(),
		"ANTHROPIC_DEFAULT_SONNET_MODEL": models.Stable(),
		"ANTHROPIC_DEFAULT_FABLE_MODEL":  models.Stable(),
	}
}

// Configure points Claude Code at the router at baseURL, starts it on the
// launch's default model and, unless the user passed their own --settings,
// adds Dari's status line and lists the router's models in /model.
func Configure(command *agents.Command, key, baseURL string, models agents.Models) error {
	command.Env = agents.WithEnvironment(command.Env, routingEnvironment(key, baseURL, models))
	if !agents.ArgsContainFlag(command.Args, "--settings") {
		if err := injectSettings(command, models); err != nil {
			return err
		}
	}
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--model", models.Default()})
	return nil
}

// pickerOptions are /model rows for the router's models. Claude Code sends a
// row's model id as written, so each row reaches the router unchanged.
func pickerOptions(models agents.Models) []map[string]string {
	options := []map[string]string{}
	for _, model := range models.Menu() {
		label := strings.TrimPrefix(model, agents.ExplicitModelPrefix)
		if model == agents.RoutingModel {
			label = "Dari Routing"
		}
		options = append(options, map[string]string{"model": model, "label": label})
	}
	for _, id := range models.Unavailable {
		provider, _, _ := strings.Cut(id, "/")
		options = append(options, map[string]string{
			"model": agents.ExplicitModelPrefix + id,
			"label": id + " · needs an account or API key for " + provider,
		})
	}
	return options
}

// injectSettings passes the status line and model picker to Claude Code. Where
// the launcher can hand its process over, they go inline, so no file is left
// behind. Elsewhere they go in a temporary file: an npm claude.cmd shim does not
// pass an inline JSON argument through intact.
func injectSettings(command *agents.Command, models agents.Models) error {
	executable, err := agents.StatusExecutable()
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{
		"statusLine": map[string]any{
			"type":    "command",
			"command": agents.ShellQuote(executable) + " agent-status --claude",
		},
		// Replace Claude Code's built-in lineup: only the router's models appear.
		"modelPicker": map[string]any{"options": pickerOptions(models), "replaceBuiltInOptions": true},
	})
	if err != nil {
		return fmt.Errorf("encode Claude status settings: %w", err)
	}
	if agents.CanReplaceProcess {
		command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--settings", string(body)})
		return nil
	}
	path, err := writeSettingsFile(body)
	if err != nil {
		return err
	}
	command.Cleanup = func() { _ = os.Remove(path) }
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--settings", path})
	return nil
}

func writeSettingsFile(body []byte) (string, error) {
	settings, err := os.CreateTemp("", "dari-claude-settings-*.json")
	if err != nil {
		return "", fmt.Errorf("create temporary Claude settings: %w", err)
	}
	path := settings.Name()
	_, err = settings.Write(body)
	closeErr := settings.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("write Claude status settings: %w", err)
	}
	return path, nil
}

// TranscriptStatus renders the status line from the status-line input Claude
// Code passes on stdin. The transcript keeps routing metadata and usage on
// each assistant entry.
func TranscriptStatus(input io.Reader) (agents.Status, error) {
	var payload struct {
		TranscriptPath string `json:"transcript_path"`
	}
	if err := json.NewDecoder(io.LimitReader(input, 1<<20)).Decode(&payload); err != nil {
		return agents.Status{}, err
	}
	file, err := os.Open(payload.TranscriptPath)
	if err != nil {
		return agents.Status{}, err
	}
	defer file.Close()
	var last agents.Status
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	for scanner.Scan() {
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				Routing agents.Status `json:"dari_routing"`
			} `json:"message"`
		}
		if json.Unmarshal(scanner.Bytes(), &entry) == nil && entry.Type == "assistant" && entry.Message.Routing.Model != "" {
			last = entry.Message.Routing
		}
	}
	return last, scanner.Err()
}
