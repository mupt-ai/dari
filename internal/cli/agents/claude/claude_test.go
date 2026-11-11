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
)

func TestBuildClaudeAgentCommandPassesStatusLineInline(t *testing.T) {
	if !agents.CanReplaceProcess {
		t.Skip("settings go in a temporary file where the launcher cannot hand over its process")
	}
	command := agents.Command{Path: "/claude", Args: []string{"--print", "review"}}
	if err := Configure(&command, "dari_route", "https://routing.dari.dev", agents.Models{Routing: true}); err != nil {
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
	}
	if err := json.Unmarshal([]byte(data), &settings); err != nil {
		t.Fatalf("--settings is not inline JSON: %v", err)
	}
	for _, name := range []string{"ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL"} {
		if got := agents.EnvironmentValue(command.Env, name); got != agents.RoutingModel {
			t.Errorf("%s = %q, want the launch's model", name, got)
		}
	}
	// The picker lists only the router's models, in place of Claude's own.
	if !settings.ModelPicker.ReplaceBuiltInOptions || len(settings.ModelPicker.Options) == 0 {
		t.Fatalf("modelPicker = %+v; want the router's models replacing the built-in lineup", settings.ModelPicker)
	}
	if settings.StatusLine.Type != "command" {
		t.Fatalf("statusLine.type = %q", settings.StatusLine.Type)
	}
	if !strings.Contains(settings.StatusLine.Command, " agent-status --claude") {
		t.Fatalf("status command = %q", settings.StatusLine.Command)
	}
	if strings.Contains(data, "dari_route") {
		t.Fatal("Claude status settings contain the secret key")
	}
}

func TestBuildClaudeAgentCommandSkipsStatusLineWhenSettingsFlagPresent(t *testing.T) {
	command := agents.Command{Path: "/claude", Args: []string{"--settings", "mine.json"}}
	if err := Configure(&command, "dari_route", "https://routing.dari.dev", agents.Models{Routing: true}); err != nil {
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
		status, err := TranscriptStatus(strings.NewReader(string(encoded)))
		if err != nil {
			t.Fatal(err)
		}
		return status.String()
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

// A /model pick starts the next launch on that model, but the aliases and
// subagents stay on the stable model: they are fixed for the session and
// settings, so following the pick would strand them on a model the user left.
func TestConfigurePinsAliasesToStableModelNotSavedPick(t *testing.T) {
	saved := "dari/model/anthropic/claude-opus-5-5"
	models := agents.Models{Routing: true, Enabled: []string{"anthropic/claude-opus-5-5"}, Saved: saved}
	command := agents.Command{Path: "/claude"}
	if err := Configure(&command, "dari_route", "https://routing.dari.dev", models); err != nil {
		t.Fatal(err)
	}
	if i := slices.Index(command.Args, "--model"); i < 0 || command.Args[i+1] != saved {
		t.Fatalf("args = %q, want the launch to start on the saved pick %q", command.Args, saved)
	}
	for _, name := range []string{"CLAUDE_CODE_SUBAGENT_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL"} {
		if got := agents.EnvironmentValue(command.Env, name); got != agents.RoutingModel {
			t.Errorf("%s = %q, want %q", name, got, agents.RoutingModel)
		}
	}
}
