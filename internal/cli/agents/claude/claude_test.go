package claude

import (
	"encoding/json"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestBuildClaudeAgentCommandPassesStatusLineInline(t *testing.T) {
	if !agents.CanReplaceProcess {
		t.Skip("settings go in a temporary file where the launcher cannot hand over its process")
	}
	command := agents.Command{Path: "/claude", Args: []string{"--print", "review"}}
	if err := Configure(&command, "dari_route", "https://routing.dari.dev", agents.Models{Routing: true}, false); err != nil {
		t.Fatal(err)
	}
	// Inline settings leave no file behind, so the launcher has nothing to clean up.
	if command.Cleanup != nil {
		t.Fatal("Claude command should not need cleanup: its settings are inline")
	}

	settingsIndex := slices.Index(command.Args, "--settings")
	if settingsIndex < 0 || settingsIndex+1 >= len(command.Args) {
		t.Fatalf("args do not contain --settings: %q", command.Args)
	}
	data := command.Args[settingsIndex+1]
	var settings struct {
		StatusLine struct {
			Type            string `json:"type"`
			Command         string `json:"command"`
			RefreshInterval int    `json:"refreshInterval"`
		} `json:"statusLine"`
		ModelPicker struct {
			Options               []map[string]string `json:"options"`
			ReplaceBuiltInOptions bool                `json:"replaceBuiltInOptions"`
		} `json:"modelPicker"`
		Hooks struct {
			UserPromptSubmit []struct {
				Hooks []struct{ Command string } `json:"hooks"`
			} `json:"UserPromptSubmit"`
		} `json:"hooks"`
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal([]byte(data), &settings); err != nil {
		t.Fatalf("--settings is not inline JSON: %v", err)
	}
	// The picker lists only the router's models, in place of Claude's own.
	if !settings.ModelPicker.ReplaceBuiltInOptions || len(settings.ModelPicker.Options) == 0 {
		t.Fatalf("modelPicker = %+v; want the router's models replacing the built-in lineup", settings.ModelPicker)
	}
	// Each prompt notes the session in its repository, for commits it makes.
	if prompt := settings.Hooks.UserPromptSubmit; len(prompt) != 1 || len(prompt[0].Hooks) != 1 ||
		!strings.HasSuffix(prompt[0].Hooks[0].Command, " agent-hook --claude") {
		t.Fatalf("UserPromptSubmit hooks = %+v", prompt)
	}
	if settings.StatusLine.Type != "command" {
		t.Fatalf("statusLine.type = %q", settings.StatusLine.Type)
	}
	if !strings.Contains(settings.StatusLine.Command, " agent-status --claude") {
		t.Fatalf("status command = %q", settings.StatusLine.Command)
	}
	// The launch's router wins over one `dari setup claude --cli` wrote into
	// Claude Code's own settings, whose env beats the process environment.
	if settings.Env["ANTHROPIC_BASE_URL"] != "https://routing.dari.dev" {
		t.Fatalf("settings env = %v; want the launch's router", settings.Env)
	}
	if strings.Contains(data, "dari_route") {
		t.Fatal("Claude status settings contain the secret key")
	}
}

// A launch through this computer's gateway has the gateway's own key, which
// must win over the hosted key `dari setup claude --cli` saved in Claude
// Code's settings, without showing in the process arguments.
func TestBuildClaudeAgentCommandCarriesItsOwnKeyInAPrivateFile(t *testing.T) {
	command := agents.Command{Path: "/claude", Args: []string{"--print", "review"}}
	if err := Configure(&command, "dari_local", "http://127.0.0.1:7340/rtr_1", agents.Models{Routing: true}, true); err != nil {
		t.Fatal(err)
	}
	if command.Cleanup == nil {
		t.Fatal("the settings file holding the key must be removed after the launch")
	}
	settingsIndex := slices.Index(command.Args, "--settings")
	if settingsIndex < 0 || settingsIndex+1 >= len(command.Args) {
		t.Fatalf("args do not contain --settings: %q", command.Args)
	}
	if strings.Contains(strings.Join(command.Args, " "), "dari_local") {
		t.Fatal("the key is in the process arguments")
	}
	path := command.Args[settingsIndex+1]
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("settings file mode = %v; want only this user to read it", info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatal(err)
	}
	if settings.Env["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:7340/rtr_1" {
		t.Fatalf("settings env = %v; want the launch's router", settings.Env)
	}
	// Each key field is set, so a saved one cannot be sent in its place.
	for _, name := range []string{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", customHeadersEnv} {
		if _, ok := settings.Env[name]; !ok {
			t.Fatalf("settings env has no %s: %v", name, settings.Env)
		}
	}
	if settings.Env["ANTHROPIC_AUTH_TOKEN"] != "dari_local" && !strings.Contains(settings.Env[customHeadersEnv], "Bearer dari_local") {
		t.Fatalf("settings env does not carry the launch's key")
	}
	command.Cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("settings file still exists after cleanup: %v", err)
	}
}

func TestBuildClaudeAgentCommandSkipsStatusLineWhenSettingsFlagPresent(t *testing.T) {
	command := agents.Command{Path: "/claude", Args: []string{"--settings", "mine.json"}}
	if err := Configure(&command, "dari_route", "https://routing.dari.dev", agents.Models{Routing: true}, false); err != nil {
		t.Fatal(err)
	}
	if command.Cleanup != nil {
		t.Fatal("Claude command should not own cleanup when --settings is already set")
	}
	if slices.Index(command.Args, "--settings") != 0 || command.Args[1] != "mine.json" {
		t.Fatalf("args = %q", command.Args)
	}
}

func TestClaudeStatusLineReadsDariRouting(t *testing.T) {
	transcript := filepath.Join(t.TempDir(), "transcript.jsonl")
	assistant := func(model, requestID string) map[string]any {
		return map[string]any{"type": "assistant", "message": map[string]any{
			"model": model,
			"dari_routing": map[string]any{
				"selected_model":        model,
				"reasoning_effort":      "high",
				"lease_turns_remaining": 1,
				"request_id":            requestID,
			},
		}}
	}
	writeTranscript := func(lines ...map[string]any) {
		t.Helper()
		var body strings.Builder
		for _, line := range append([]map[string]any{{"type": "user", "message": map[string]any{"role": "user"}}}, lines...) {
			encoded, err := json.Marshal(line)
			if err != nil {
				t.Fatal(err)
			}
			body.Write(encoded)
			body.WriteByte('\n')
		}
		if err := os.WriteFile(transcript, []byte(body.String()), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	render := func(stdin map[string]any) string {
		t.Helper()
		encoded, err := json.Marshal(stdin)
		if err != nil {
			t.Fatal(err)
		}
		lines, err := StatusLines(strings.NewReader(string(encoded)), time.Now())
		if err != nil {
			t.Fatal(err)
		}
		return strings.Join(lines, "\n")
	}
	stdin := map[string]any{"transcript_path": transcript}
	for _, tc := range []struct {
		lines []map[string]any
		want  string
	}{
		{[]map[string]any{assistant("xai/grok-4.6", "req_1")}, "xai/grok-4.6 · high · lease 2 turns left · https://app.dari.dev/activity/conversations/req_1"},
		// The last assistant entry wins, so a model switch shows the new turn's link.
		{[]map[string]any{assistant("xai/grok-4.6", "req_1"), assistant("openai/gpt-5.5", "req_2")}, "openai/gpt-5.5 · high · lease 2 turns left · https://app.dari.dev/activity/conversations/req_2"},
		{[]map[string]any{{"type": "assistant", "message": map[string]any{
			"model": "openai/gpt-5.5",
			"dari_routing": map[string]any{
				"selected_model":   "openai/gpt-5.5",
				"reasoning_effort": "high",
				"session_pinned":   true,
				"request_id":       "req_3",
			},
		}}}, "openai/gpt-5.5 · high · pinned · https://app.dari.dev/activity/conversations/req_3"},
	} {
		writeTranscript(tc.lines...)
		if got := render(stdin); got != tc.want {
			t.Errorf("status = %q, want %q", got, tc.want)
		}
	}

	// Each running subagent gets a line with the model and lease it is on;
	// one that finished, or went quiet long ago, gets none.
	subagents := filepath.Join(strings.TrimSuffix(transcript, ".jsonl"), "subagents")
	if err := os.MkdirAll(subagents, 0o700); err != nil {
		t.Fatal(err)
	}
	writeSubagent := func(id, agentType string, finished bool, model string, age time.Duration) {
		t.Helper()
		meta, _ := json.Marshal(map[string]any{"agentType": agentType, "finished": finished})
		entry, _ := json.Marshal(assistant(model, "req_sub"))
		path := filepath.Join(subagents, "agent-"+id+".jsonl")
		for name, data := range map[string][]byte{path: append(entry, '\n'), filepath.Join(subagents, "agent-"+id+".meta.json"): meta} {
			if err := os.WriteFile(name, data, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		when := time.Now().Add(-age)
		if err := os.Chtimes(path, when, when); err != nil {
			t.Fatal(err)
		}
	}
	writeSubagent("a1", "Explore", false, "deepseek-ai/DeepSeek-V4.1-Flash-1017", time.Minute)
	writeSubagent("a2", "general-purpose", true, "anthropic/claude-opus-5-5", time.Minute)
	writeSubagent("a3", "Plan", false, "anthropic/claude-opus-5-5", time.Hour)
	want := "openai/gpt-5.5 · high · pinned · https://app.dari.dev/activity/conversations/req_3\n" +
		"↳ Explore · deepseek-ai/DeepSeek-V4.1-Flash-1017 · high · lease 2 turns left"
	if got := render(stdin); got != want {
		t.Errorf("status = %q, want %q", got, want)
	}
}

// Claude Code's /model lists every model the user chose: ones no account or
// API key serves yet come last, labeled with what they need, and never become
// the default.
func TestPickerListsEveryChosenModel(t *testing.T) {
	models := agents.Models{
		Enabled:     []string{"anthropic/claude-sonnet-5-5"},
		Unavailable: []string{"openai/gpt-6.1-sol"},
	}
	got := pickerOptions(models)
	want := []map[string]string{
		{"model": "dari/model/anthropic/claude-sonnet-5-5", "label": "anthropic/claude-sonnet-5-5"},
		{"model": "dari/model/openai/gpt-6.1-sol", "label": "openai/gpt-6.1-sol · needs an account or API key for openai"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pickerOptions = %v, want %v", got, want)
	}
	if models.Default() != "dari/model/anthropic/claude-sonnet-5-5" {
		t.Fatalf("default = %q", models.Default())
	}
}

func TestClaudeCompactsAgainstTheRoutersContextWindow(t *testing.T) {
	for _, tc := range []struct {
		window int
		want   string
	}{{272_000, "272000"}, {0, "1000000"}} {
		env := routingEnvironment("dari_route", "https://routing.dari.dev", "", false, agents.Models{Routing: true, ContextWindow: tc.window})
		if got := env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"]; got != tc.want {
			t.Errorf("window %d: CLAUDE_CODE_MAX_CONTEXT_TOKENS = %q, want %q", tc.window, got, tc.want)
		}
	}
}
