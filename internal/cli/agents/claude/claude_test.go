package claude

import (
	"encoding/json"
	"github.com/mupt-ai/dari-cli/internal/cli/agents"
	"os"
	"path/filepath"
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
