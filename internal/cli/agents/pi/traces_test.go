package pi

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/tracetest"
)

// testdata holds synthetic transcripts: each has the shape of the lines
// Pi writes, with made-up content.

func TestParsePiSession(t *testing.T) {
	sessions, err := parsePiSession(filepath.Join("testdata", "session.jsonl"), time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("contexts = %d, want one before the compaction and one after", len(sessions))
	}
	first := sessions[0]
	wantItems := []string{
		"user:read the config", "reasoning", "call:call_1", "result:call_1=port: 80",
		"assistant:Port 80.", "user:and the host?", "assistant:localhost",
	}
	if got := tracetest.Summaries(first.Items); !reflect.DeepEqual(got, wantItems) {
		t.Errorf("items = %q\n want %q", got, wantItems)
	}
	// e4 was routed by Dari and e6 failed.
	wantTurns := []agents.Turn{
		{
			RequestID: agents.RequestID("pi", "sess-pi", "e2"), InputItems: 1, OutputItems: 2,
			Model: "openai/gpt-5.5", Provider: "openai-codex",
			ReceivedAt: tracetest.Time(t, "2026-03-02T01:00:01.5Z"), CompletedAt: tracetest.Time(t, "2026-03-02T01:00:03Z"),
			StopReason: "tool_use",
			Usage:      agents.Usage{InputTokens: 11, OutputTokens: 6, CacheReadTokens: 90},
		},
		{
			RequestID: agents.RequestID("pi", "sess-pi", "e7"), InputItems: 6, OutputItems: 1,
			Model: "anthropic/claude-opus-4-8", Provider: "anthropic",
			ReceivedAt: tracetest.Time(t, "2026-03-02T01:00:08Z"), CompletedAt: tracetest.Time(t, "2026-03-02T01:00:09Z"),
			StopReason: "stop",
			Usage:      agents.Usage{InputTokens: 8, OutputTokens: 1, CacheWriteTokens: 30},
		},
	}
	if !reflect.DeepEqual(first.Turns, wantTurns) {
		t.Errorf("turns = %+v\n want %+v", first.Turns, wantTurns)
	}
	second := sessions[1]
	if got := tracetest.Summaries(second.Items); !reflect.DeepEqual(got, []string{"user:The config was read.", "assistant:Anything else?"}) {
		t.Errorf("items after compaction = %q", got)
	}
	// A model no catalog owner is known for keeps its own name.
	if turn := second.Turns[0]; turn.Model != "gemma4:31b" || turn.Provider != "ollama" || turn.StopReason != "length" {
		t.Errorf("turn after compaction = %+v", turn)
	}
}
