// Package claude launches Claude Code through Dari and renders its status
// line from the session transcript.
package claude

import (
	"bufio"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

const (
	customHeadersEnv = "ANTHROPIC_CUSTOM_HEADERS"
	subagentModelEnv = "CLAUDE_CODE_SUBAGENT_MODEL"
	// autoModeModelEnv is the model auto mode's safety classifier asks for;
	// without it the classifier follows the sonnet alias.
	autoModeModelEnv = "CLAUDE_CODE_AUTO_MODE_MODEL"
)

// aliasEnvironment maps each model alias Claude Code accepts (in /model, an
// Agent tool call, or an agent definition) to the variable that resolves it.
var aliasEnvironment = map[string]string{
	"opus":   "ANTHROPIC_DEFAULT_OPUS_MODEL",
	"sonnet": "ANTHROPIC_DEFAULT_SONNET_MODEL",
	"fable":  "ANTHROPIC_DEFAULT_FABLE_MODEL",
	"haiku":  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
}

// aliasModel is the model an alias names: the router's first model of that
// Claude family, and whether the router has one. Without one it still names
// the family, so requests for it fail with "not enabled on this router"
// instead of quietly running on another model.
func aliasModel(models agents.Models, alias string) (string, bool) {
	prefix := "anthropic/claude-" + alias + "-"
	for _, id := range append(slices.Clone(models.Enabled), models.Unavailable...) {
		if strings.HasPrefix(id, prefix) {
			return agents.ExplicitModelPrefix + id, true
		}
	}
	return agents.ExplicitModelPrefix + "anthropic/claude-" + alias, false
}

// routesSubagents reports whether subagents are pinned to Dari Routing. Without
// it Claude Code runs a subagent that names no model on the session's current
// model, following each /model switch.
func routesSubagents(models agents.Models) bool {
	return models.Stable() == agents.RoutingModel
}

// StartModel is the model a launch starts on: the user's Dari pick, kept even
// while the router cannot serve it (its requests fail until they pick another
// with /model, rather than quietly running on a different model), else the
// launch's default.
func StartModel(models agents.Models) string {
	if strings.HasPrefix(models.Saved, "dari/") {
		return models.Saved
	}
	return models.Default()
}

// Warnings name the model choices this router cannot serve: the saved pick,
// and the aliases whose Claude family it does not enable. hosted says a saved
// Dari Routing pick fails without the Autorouting plan; a gateway serves it
// either way.
func Warnings(models agents.Models, hosted bool) []string {
	var warnings []string
	if saved := models.Saved; strings.HasPrefix(saved, "dari/") && !slices.Contains(models.Menu(), saved) {
		reason := "it is not enabled on this router"
		switch {
		case saved == agents.RoutingModel:
			reason = "it needs the Autorouting plan; run `dari accounts` to get it"
			if !hosted {
				reason = ""
			}
		case slices.Contains(models.Unavailable, strings.TrimPrefix(saved, agents.ExplicitModelPrefix)):
			reason = "no connected account or API key serves it yet"
		}
		if reason != "" {
			warnings = append(warnings, fmt.Sprintf("Your saved model %s is not available: %s. Its requests fail until you pick another with /model.", saved, reason))
		}
	}
	var missing []string
	for _, alias := range []string{"opus", "sonnet", "fable", "haiku"} {
		if _, ok := aliasModel(models, alias); !ok {
			missing = append(missing, alias)
		}
	}
	if len(missing) > 0 {
		warnings = append(warnings, fmt.Sprintf("Not enabled on this router: %s. Claude Code requests for them (such as a subagent's model) fail.", strings.Join(missing, ", ")))
	}
	return warnings
}

// routingEnvironment points Claude Code at the router at baseURL: what a
// launch sets for its session, and what setup writes into Claude Code's
// settings so `claude` itself routes the same way. headers is the
// ANTHROPIC_CUSTOM_HEADERS already set; its other headers are kept.
//
// Claude Code turns off claude.ai features (connectors, Artifacts) whenever
// ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is set, since either takes
// precedence over its claude.ai login. So when Claude Code is signed in to
// claude.ai, the key goes in a custom Authorization header instead: Claude
// Code sends that to the router in place of its claude.ai token and keeps the
// login for claude.ai. Without a login the header alone leaves Claude Code
// showing "Not logged in", so the key stays in ANTHROPIC_AUTH_TOKEN.
func routingEnvironment(key, baseURL, headers string, claudeAI bool, models agents.Models) map[string]string {
	authToken, headerKey := key, ""
	if claudeAI {
		authToken, headerKey = "", key
	}
	env := map[string]string{
		"ANTHROPIC_BASE_URL":               baseURL,
		"ANTHROPIC_AUTH_TOKEN":             authToken,
		"ANTHROPIC_API_KEY":                "",
		customHeadersEnv:                   customHeaders(headers, headerKey),
		"CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1",
		"CLAUDE_CODE_MAX_CONTEXT_TOKENS":   strconv.Itoa(contextWindow(models)),
		// The classifier's requests are background work, which Dari serves on
		// the cheapest model for dari/routing, with or without the plan.
		autoModeModelEnv: agents.RoutingModel,
	}
	// Each alias names its own model, never a stand-in, so `opus` is Opus.
	for alias, name := range aliasEnvironment {
		env[name], _ = aliasModel(models, alias)
	}
	if routesSubagents(models) {
		env[subagentModelEnv] = agents.RoutingModel
	}
	return env
}

// contextWindow is the window Claude Code compacts against: the router's for
// the session's stable model, so compaction runs before a model's
// standard-price limit rejects the prompt. Without one it keeps the 1M
// window most of Dari's models serve.
func contextWindow(models agents.Models) int {
	if models.ContextWindow > 0 {
		return models.ContextWindow
	}
	return 1_000_000
}

// customHeaders is an ANTHROPIC_CUSTOM_HEADERS value, one "Name: value" per
// line: headers without its Authorization, then the key's, if any.
func customHeaders(headers, key string) string {
	lines := []string{}
	for _, line := range strings.Split(headers, "\n") {
		name, _, _ := strings.Cut(line, ":")
		if strings.TrimSpace(line) != "" && !strings.EqualFold(strings.TrimSpace(name), "authorization") {
			lines = append(lines, line)
		}
	}
	if key != "" {
		lines = append(lines, "Authorization: Bearer "+key)
	}
	return strings.Join(lines, "\n")
}

// SignedInToClaudeAI reports whether the Claude Code at executable has a
// claude.ai login, looking past the routing credentials Dari sets.
func SignedInToClaudeAI(executable string) bool {
	if executable == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// Settings passed on the command line override the env in Claude Code's
	// settings file, where setup writes the routing credentials.
	// Like injectSettings, use a file where an npm claude.cmd shim would mangle
	// inline JSON.
	cleared := `{"env":{"ANTHROPIC_AUTH_TOKEN":"","ANTHROPIC_API_KEY":"","ANTHROPIC_CUSTOM_HEADERS":""}}`
	if !agents.CanReplaceProcess {
		path, err := writeSettingsFile([]byte(cleared))
		if err != nil {
			return false
		}
		defer os.Remove(path)
		cleared = path
	}
	output, err := exec.CommandContext(ctx, executable, "--settings", cleared, "auth", "status", "--json").Output()
	if err != nil {
		return false
	}
	var status struct {
		AuthMethod string `json:"authMethod"`
	}
	return json.Unmarshal(output, &status) == nil && status.AuthMethod == "claude.ai"
}

// Configure points Claude Code at the router at baseURL, starts it on
// StartModel and, unless the user passed their own --settings,
// adds Dari's status line and lists the router's models in /model.
// ownKey is a launch whose key is not the hosted routing key `dari setup
// claude --cli` saves, such as one through this computer's gateway.
func Configure(command *agents.Command, key, baseURL string, models agents.Models, ownKey bool) error {
	headers := agents.EnvironmentValue(command.Env, customHeadersEnv)
	env := routingEnvironment(key, baseURL, headers, SignedInToClaudeAI(command.Path), models)
	command.Env = agents.WithEnvironment(command.Env, env)
	if _, ok := env[subagentModelEnv]; !ok {
		// Not one inherited from a parent session's pin either.
		command.Env = agents.WithoutEnvironment(command.Env, subagentModelEnv)
	}
	if !agents.ArgsContainFlag(command.Args, "--settings") {
		if err := injectSettings(command, models, env, ownKey); err != nil {
			return err
		}
	}
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--model", StartModel(models)})
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

// statusLineSettings is Claude Code's status line: Dari's renderer, run again
// every few seconds so running subagents' models and leases stay current
// while the main agent waits on them and nothing else refreshes the line.
func statusLineSettings() (map[string]any, error) {
	executable, err := agents.StatusExecutable()
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"type":            "command",
		"command":         agents.ShellQuote(executable) + " agent-status --claude",
		"refreshInterval": 5,
	}, nil
}

// injectSettings passes the status line, the model picker, and the prompt hook
// that notes the session in its repository (for `dari git-hook`). Where
// the launcher can hand its process over, they go inline, so no file is left
// behind. Elsewhere they go in a temporary file: an npm claude.cmd shim does not
// pass an inline JSON argument through intact.
//
// They carry the launch's router too. `dari setup claude --cli` writes a
// router and the hosted routing key into Claude Code's own settings, whose
// env wins over the process environment; without this a launch on another
// router (--router) would be sent to the one set up. The hosted key is the
// same for every router, so it stays out of the arguments, which other
// processes can read. A launch with its own key (ownKey) carries it too, in
// a temporary file only this user can read, or the saved hosted key would
// be sent in its place and refused.
func injectSettings(command *agents.Command, models agents.Models, env map[string]string, ownKey bool) error {
	statusLine, err := statusLineSettings()
	if err != nil {
		return err
	}
	executable, err := agents.StatusExecutable()
	if err != nil {
		return err
	}
	// A subagent pin the launch does not set is cleared, not left to the
	// one in Claude Code's own settings.
	routing := map[string]string{subagentModelEnv: ""}
	for name, value := range env {
		if ownKey || (name != "ANTHROPIC_AUTH_TOKEN" && name != "ANTHROPIC_API_KEY" && name != customHeadersEnv) {
			routing[name] = value
		}
	}
	body, err := json.Marshal(map[string]any{
		"env":        routing,
		"statusLine": statusLine,
		// Replace Claude Code's built-in lineup: only the router's models appear.
		"modelPicker": map[string]any{"options": pickerOptions(models), "replaceBuiltInOptions": true},
		"hooks": map[string]any{
			"UserPromptSubmit": []any{map[string]any{"hooks": []any{map[string]any{
				"type":    "command",
				"command": agents.ShellQuote(executable) + " agent-hook --claude",
			}}}},
		},
	})
	if err != nil {
		return fmt.Errorf("encode Claude status settings: %w", err)
	}
	if agents.CanReplaceProcess && !ownKey {
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

// subagentQuietAfter is how long a subagent may write nothing before the
// status line stops showing it as running: one that died never says so.
const subagentQuietAfter = 10 * time.Minute

// subagentStatusMax is how many running subagents get their own line.
const subagentStatusMax = 3

// transcriptTail is how much of a transcript's end is read for its latest
// routing before falling back to all of it.
const transcriptTail = 512 << 10

// StatusLines renders the status line from the input Claude Code passes on
// stdin: the session's own routing, then a line for each running subagent
// with the model and lease it is on. Claude Code does not say which agent is
// on screen, so every running one is shown. Transcripts keep routing metadata
// on each assistant entry.
func StatusLines(input io.Reader, now time.Time) ([]string, error) {
	var payload struct {
		TranscriptPath string `json:"transcript_path"`
	}
	if err := json.NewDecoder(io.LimitReader(input, 1<<20)).Decode(&payload); err != nil {
		return nil, err
	}
	session, err := lastRouting(payload.TranscriptPath)
	if err != nil && session.Model == "" {
		return nil, err
	}
	lines := []string{}
	if text := session.String(); text != "" {
		lines = append(lines, text)
	}
	return append(lines, subagentStatusLines(payload.TranscriptPath, now)...), nil
}

// subagentStatusLines are the running subagents of the session whose
// transcript is at transcriptPath, most recently active first. Claude Code
// keeps each one's transcript and a note about it beside the session's.
func subagentStatusLines(transcriptPath string, now time.Time) []string {
	notes, _ := filepath.Glob(filepath.Join(strings.TrimSuffix(transcriptPath, ".jsonl"), "subagents", "agent-*.meta.json"))
	type subagent struct {
		line   string
		active time.Time
	}
	var running []subagent
	for _, note := range notes {
		var meta struct {
			AgentType string `json:"agentType"`
			Finished  bool   `json:"finished"`
		}
		data, err := os.ReadFile(note)
		if err != nil || json.Unmarshal(data, &meta) != nil || meta.Finished {
			continue
		}
		transcript := strings.TrimSuffix(note, ".meta.json") + ".jsonl"
		info, err := os.Stat(transcript)
		if err != nil || now.Sub(info.ModTime()) > subagentQuietAfter {
			continue
		}
		status, _ := lastRouting(transcript)
		// The session's line carries the Activity link, or says it is private.
		status.RequestID, status.Private = "", false
		text := status.String()
		if text == "" {
			continue
		}
		label := cmp.Or(agents.StatusLabel(meta.AgentType), "subagent")
		running = append(running, subagent{line: "↳ " + label + " · " + text, active: info.ModTime()})
	}
	slices.SortStableFunc(running, func(a, b subagent) int { return b.active.Compare(a.active) })
	lines := []string{}
	for i, agent := range running {
		if i == subagentStatusMax {
			lines = append(lines, fmt.Sprintf("↳ +%d more", len(running)-i))
			break
		}
		lines = append(lines, agent.line)
	}
	return lines
}

// lastRouting is the routing on a transcript's latest assistant entry. It
// reads the transcript's end first: the status line runs every few seconds,
// and a long session's transcript is large.
func lastRouting(path string) (agents.Status, error) {
	file, err := os.Open(path)
	if err != nil {
		return agents.Status{}, err
	}
	defer file.Close()
	if info, err := file.Stat(); err == nil && info.Size() > transcriptTail {
		if _, err := file.Seek(-transcriptTail, io.SeekEnd); err == nil {
			tail := bufio.NewReader(file)
			// The first line is cut off.
			_, _ = tail.ReadString('\n')
			if status, err := scanRouting(tail); err == nil && status.Model != "" {
				return status, nil
			}
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return agents.Status{}, err
		}
	}
	return scanRouting(file)
}

// scanRouting keeps whatever it read when the transcript cannot be read to
// its end, and reads lines of any length: one huge tool result must not
// blank the status line.
func scanRouting(transcript io.Reader) (agents.Status, error) {
	var last agents.Status
	reader := bufio.NewReaderSize(transcript, 64<<10)
	for {
		line, err := reader.ReadBytes('\n')
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				Routing agents.Status `json:"dari_routing"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &entry) == nil && entry.Type == "assistant" && entry.Message.Routing.Model != "" {
			last = entry.Message.Routing
		}
		if err == io.EOF {
			return last, nil
		}
		if err != nil {
			return last, err
		}
	}
}
