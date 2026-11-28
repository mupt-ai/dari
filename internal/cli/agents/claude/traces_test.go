package claude

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/tracetest"
)

// testdata holds synthetic transcripts: each has the shape of the lines
// Claude Code writes, with made-up content.

func TestParseClaudeTranscript(t *testing.T) {
	path := filepath.Join("testdata", "transcript.jsonl")
	sessions, err := parseClaudeTranscript(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("contexts = %d, want one before the compaction and one after", len(sessions))
	}
	first := sessions[0]
	if first.Agent != "claude" || first.SessionID != "sess-claude" || first.AgentID != "" {
		t.Errorf("session = %+v", first)
	}
	// msg_1's last block was written after its first tool finished; it still
	// precedes that tool's result.
	wantItems := []string{
		"user:list the files", "reasoning", "call:toolu_a", "call:toolu_b",
		"result:toolu_a=README.md", "result:toolu_b=main.go\n[image]",
		"assistant:Two files.", "user:thanks", "assistant:Welcome.",
	}
	if got := tracetest.Summaries(first.Items); !reflect.DeepEqual(got, wantItems) {
		t.Errorf("items = %q\n want %q", got, wantItems)
	}
	// msg_2 was routed by Dari and the synthetic notice is not a model call.
	wantTurns := []agents.Turn{
		{
			RequestID: agents.RequestID("claude", "sess-claude", "msg_1"), InputItems: 1, OutputItems: 3,
			Model: "anthropic/claude-opus-4-8", Provider: "anthropic",
			ReceivedAt: tracetest.Time(t, "2026-03-02T01:00:00Z"), CompletedAt: tracetest.Time(t, "2026-03-02T01:00:04Z"),
			StopReason: "tool_use",
			Usage:      agents.Usage{InputTokens: 10, OutputTokens: 5, CacheReadTokens: 100, CacheWriteTokens: 20},
		},
		{
			RequestID: agents.RequestID("claude", "sess-claude", "msg_3"), InputItems: 8, OutputItems: 1,
			Model: "anthropic/claude-opus-4-8", Provider: "anthropic",
			ReceivedAt: tracetest.Time(t, "2026-03-02T01:00:07Z"), CompletedAt: tracetest.Time(t, "2026-03-02T01:00:08Z"),
			StopReason: "stop",
			Usage:      agents.Usage{InputTokens: 4, OutputTokens: 1},
		},
	}
	if !reflect.DeepEqual(first.Turns, wantTurns) {
		t.Errorf("turns = %+v\n want %+v", first.Turns, wantTurns)
	}
	second := sessions[1]
	if got := tracetest.Summaries(second.Items); !reflect.DeepEqual(got, []string{"user:Summary of the session so far.", "assistant:Continuing."}) {
		t.Errorf("items after compaction = %q", got)
	}
	if len(second.Turns) != 1 || second.Turns[0].InputItems != 1 || second.Turns[0].StopReason != "length" {
		t.Errorf("turns after compaction = %+v", second.Turns)
	}

	since, err := parseClaudeTranscript(path, tracetest.Time(t, "2026-03-03T00:00:00Z"))
	if err != nil {
		t.Fatal(err)
	}
	if len(since) != 1 || since[0].Turns[0].RequestID != second.Turns[0].RequestID {
		t.Errorf("since the compaction = %+v", since)
	}
}

func TestParseClaudeSubagentTranscript(t *testing.T) {
	path := filepath.Join("testdata", "subagent.jsonl")
	sessions, err := parseClaudeTranscript(path, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].SessionID != "sess-claude" || sessions[0].AgentID != "agent-a" {
		t.Fatalf("sessions = %+v", sessions)
	}
	if turn := sessions[0].Turns[0]; turn.Model != "anthropic/claude-haiku-4-5" || turn.InputItems != 1 || turn.OutputItems != 1 {
		t.Errorf("turn = %+v", turn)
	}
}
