package codex

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/tracetest"
)

// testdata holds synthetic transcripts: each has the shape of the lines
// Codex writes, with made-up content.

func TestParseCodexRollout(t *testing.T) {
	sessions, err := parseCodexRollout(filepath.Join("testdata", "rollout.jsonl"), time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("contexts = %d, want one before the compaction and one after", len(sessions))
	}
	first := sessions[0]
	wantItems := []string{
		"developer:rules", "user:fix the bug", "reasoning", "call:call_1",
		"result:call_1=bug.go", "call:call_2", "result:call_2=Done",
	}
	if got := tracetest.Summaries(first.Items); !reflect.DeepEqual(got, wantItems) {
		t.Errorf("items = %q\n want %q", got, wantItems)
	}
	if call := first.Items[3]; call["namespace"] != "shell" || call["input"] != `{"cmd":"ls"}` || first.Items[5]["kind"] != "custom" {
		t.Errorf("tool calls = %v, %v", call, first.Items[5])
	}
	wantTurns := []agents.Turn{
		{
			RequestID: agents.RequestID("codex", "sess-codex", "resp_1"), InputItems: 2, OutputItems: 2,
			Model: "openai/gpt-5.5", Provider: "openai",
			ReceivedAt: tracetest.Time(t, "2026-03-02T01:00:00.3Z"), CompletedAt: tracetest.Time(t, "2026-03-02T01:00:02.1Z"),
			StopReason: "tool_use",
			// The transcript's input count includes its cache reads and writes.
			Usage: agents.Usage{InputTokens: 30, OutputTokens: 7, CacheReadTokens: 100, CacheWriteTokens: 20},
		},
		{
			RequestID: agents.RequestID("codex", "sess-codex", "resp_2"), InputItems: 5, OutputItems: 1,
			Model: "openai/gpt-5.5", Provider: "openai",
			ReceivedAt: tracetest.Time(t, "2026-03-02T01:00:02.5Z"), CompletedAt: tracetest.Time(t, "2026-03-02T01:00:03.1Z"),
			StopReason: "tool_use",
			Usage:      agents.Usage{InputTokens: 30, OutputTokens: 4},
		},
	}
	if !reflect.DeepEqual(first.Turns, wantTurns) {
		t.Errorf("turns = %+v\n want %+v", first.Turns, wantTurns)
	}
	second := sessions[1]
	if got := tracetest.Summaries(second.Items); !reflect.DeepEqual(got, []string{"user:Summary so far.", "assistant:Fixed."}) {
		t.Errorf("items after compaction = %q", got)
	}
	if len(second.Turns) != 1 || second.Turns[0].InputItems != 1 || second.Turns[0].StopReason != "stop" {
		t.Errorf("turns after compaction = %+v", second.Turns)
	}
}

// legacy-rollout.jsonl is from before usage records: the token count the
// interface showed closes each response.
func TestParseCodexRolloutWithoutUsageRecords(t *testing.T) {
	sessions, err := parseCodexRollout(filepath.Join("testdata", "legacy-rollout.jsonl"), time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || len(sessions[0].Turns) != 1 {
		t.Fatalf("sessions = %+v", sessions)
	}
	turn := sessions[0].Turns[0]
	// With no response ID, the usage line's number names the call.
	if turn.RequestID != agents.RequestID("codex", "sess-legacy", "line:5") || turn.Usage != (agents.Usage{InputTokens: 10, OutputTokens: 1, CacheReadTokens: 2}) {
		t.Errorf("turn = %+v", turn)
	}
}

func TestParseCodexRolloutSkipsDariRoutedSessions(t *testing.T) {
	sessions, err := parseCodexRollout(filepath.Join("testdata", "routed-rollout.jsonl"), time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 0 {
		t.Errorf("sessions = %+v, want none", sessions)
	}
}
