package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// TestClaudeCodeHonorsTheModelSettings runs a real Claude Code (the binary at
// DARI_TEST_CLAUDE_CODE) against a fake Anthropic API and checks the model each
// request names. The settings it relies on are partly undocumented
// (CLAUDE_CODE_AUTO_MODE_MODEL), so this catches a Claude Code release that
// stops honoring them.
func TestClaudeCodeHonorsTheModelSettings(t *testing.T) {
	binary := os.Getenv("DARI_TEST_CLAUDE_CODE")
	if binary == "" {
		t.Skip("set DARI_TEST_CLAUDE_CODE to a Claude Code binary")
	}
	models := agents.Models{Enabled: claudeRouter}
	main := "dari/model/anthropic/claude-opus-5-5"

	t.Run("a subagent that names no model runs on the session's model", func(t *testing.T) {
		seen := runClaudeCode(t, binary, models, main, `{"description":"probe","prompt":"DARI_SUBAGENT","subagent_type":"general-purpose"}`, false)
		if got := seen.first("subagent"); got != main {
			t.Fatalf("subagent model = %q, want %q (requests %v)", got, main, seen.all())
		}
	})
	t.Run("an alias names its own model", func(t *testing.T) {
		seen := runClaudeCode(t, binary, models, main, `{"description":"probe","prompt":"DARI_SUBAGENT","subagent_type":"general-purpose","model":"sonnet"}`, false)
		if got := seen.first("subagent"); got != "dari/model/anthropic/claude-sonnet-5-5" {
			t.Fatalf("subagent model = %q (requests %v)", got, seen.all())
		}
	})
	t.Run("auto mode's classifier asks for dari/routing", func(t *testing.T) {
		seen := runClaudeCode(t, binary, models, main, `{"description":"probe","prompt":"DARI_SUBAGENT","subagent_type":"general-purpose"}`, true)
		if got := seen.first("auxiliary"); got != agents.RoutingModel {
			t.Fatalf("classifier model = %q (requests %v)", got, seen.all())
		}
	})
}

type seenModels struct {
	sync.Mutex
	requests [][2]string // request class, model
}

func (s *seenModels) add(class, model string) {
	s.Lock()
	defer s.Unlock()
	s.requests = append(s.requests, [2]string{class, model})
}

func (s *seenModels) first(class string) string {
	s.Lock()
	defer s.Unlock()
	for _, request := range s.requests {
		if request[0] == class {
			return request[1]
		}
	}
	return ""
}

func (s *seenModels) all() [][2]string {
	s.Lock()
	defer s.Unlock()
	return append([][2]string(nil), s.requests...)
}

// runClaudeCode starts Claude Code on main with the environment a launch on
// models sets. The fake API answers the first main turn with an Agent tool call
// of agentInput, and everything else with text. In auto mode it stops at the
// first classifier request.
func runClaudeCode(t *testing.T, binary string, models agents.Models, main, agentInput string, autoMode bool) *seenModels {
	t.Helper()
	seen := &seenModels{}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.Path, "/v1/messages") {
			_, _ = w.Write([]byte(`{"data":[],"has_more":false}`))
			return
		}
		body, _ := io.ReadAll(r.Body)
		var request struct {
			Model    string `json:"model"`
			Stream   bool   `json:"stream"`
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		_ = json.Unmarshal(body, &request)
		if strings.Contains(r.URL.Path, "count_tokens") {
			_, _ = w.Write([]byte(`{"input_tokens":1}`))
			return
		}
		class := r.Header.Get("x-claude-code-request-class")
		seen.add(class, request.Model)
		if autoMode && class == "auxiliary" {
			cancel()
		}
		transcript := string(body)
		if class == "main" && strings.Contains(transcript, "DARI_SPAWN") && !strings.Contains(transcript, `"tool_result"`) {
			writeMessage(w, request.Model, request.Stream, map[string]any{"type": "tool_use", "id": "toolu_1", "name": "Agent", "input": json.RawMessage(agentInput)}, "tool_use")
			return
		}
		writeMessage(w, request.Model, request.Stream, map[string]any{"type": "text", "text": "done"}, "end_turn")
	}))
	defer api.Close()

	home := t.TempDir()
	config := filepath.Join(home, ".claude")
	project := filepath.Join(home, "project")
	for _, dir := range []string{config, project} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	state := fmt.Sprintf(`{"hasCompletedOnboarding":true,"projects":{%q:{"hasTrustDialogAccepted":true}}}`, project)
	if err := os.WriteFile(filepath.Join(config, ".claude.json"), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + home, "PATH=" + os.Getenv("PATH"), "CLAUDE_CONFIG_DIR=" + config, "DISABLE_AUTOUPDATER=1"}
	for name, value := range routingEnvironment("dak_test", api.URL, "", false, models) {
		env = append(env, name+"="+value)
	}
	args := []string{"-p", "--model", main}
	if autoMode {
		args = append(args, "--permission-mode", "auto")
	} else {
		args = append(args, "--allowedTools", "Agent")
	}
	command := exec.CommandContext(ctx, binary, args...)
	command.Dir, command.Env = project, env
	command.Stdin = strings.NewReader("DARI_SPAWN: start one subagent.")
	_ = command.Run()
	return seen
}

func writeMessage(w http.ResponseWriter, model string, stream bool, block map[string]any, stop string) {
	usage := map[string]int{"input_tokens": 1, "output_tokens": 1}
	if !stream {
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "msg_1", "type": "message", "role": "assistant", "model": model,
			"content": []any{block}, "stop_reason": stop, "usage": usage})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	event := func(name string, data any) {
		encoded, _ := json.Marshal(data)
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, encoded)
	}
	event("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_1", "type": "message",
		"role": "assistant", "model": model, "content": []any{}, "stop_reason": nil, "usage": usage}})
	if block["type"] == "text" {
		event("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
		event("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": block["text"]}})
	} else {
		event("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{
			"type": "tool_use", "id": block["id"], "name": block["name"], "input": map[string]any{}}})
		event("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{
			"type": "input_json_delta", "partial_json": string(block["input"].(json.RawMessage))}})
	}
	event("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	event("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop}, "usage": map[string]int{"output_tokens": 1}})
	event("message_stop", map[string]any{"type": "message_stop"})
}
