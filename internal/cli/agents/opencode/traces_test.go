package opencode

import (
	"reflect"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/tracetest"
)

func TestParseOpenCodeMessages(t *testing.T) {
	messages := []openCodeMessage{
		{SessionID: "ses_1", ID: "msg_1", Type: "user", Data: `{"text":"count the tests","time":{"created":1772413200000}}`},
		{SessionID: "ses_1", ID: "msg_2", Type: "assistant", Data: `{"content":[
			{"type":"reasoning","text":"search for them"},
			{"type":"tool","id":"call_1","name":"grep","state":{"status":"completed","input":{"pattern":"func Test"},"content":[{"type":"text","text":"12 matches"}]}}],
			"finish":"tool-calls","model":{"id":"pulse-alpha","providerID":"opencode"},
			"time":{"created":1772413201000,"completed":1772413203000},
			"tokens":{"input":20,"output":4,"reasoning":1,"cache":{"read":50,"write":5}}}`},
		{SessionID: "ses_1", ID: "msg_3", Type: "idle", Data: `{"outcome":"done"}`},
		{SessionID: "ses_1", ID: "msg_4", Type: "assistant", Data: `{"content":[{"type":"text","text":"Twelve."}],
			"finish":"stop","model":{"id":"routing","providerID":"dari"},
			"time":{"created":1772413204000,"completed":1772413205000},"tokens":{"input":9,"output":1,"cache":{"read":0,"write":0}}}`},
		{SessionID: "ses_2", ID: "msg_5", Type: "user", Data: `{"text":"hello"}`},
		{SessionID: "ses_2", ID: "msg_6", Type: "assistant", Data: `{"content":[{"type":"text","text":"hi"}],
			"finish":"stop","model":{"id":"gpt-5.5","providerID":"openai"},
			"time":{"created":1772413300000,"completed":1772413301000},"tokens":{"input":2,"output":1,"cache":{"read":0,"write":0}}}`},
	}
	sessions := parseOpenCodeMessages(messages, time.Time{})
	if len(sessions) != 2 {
		t.Fatalf("sessions = %d, want 2", len(sessions))
	}
	first := sessions[0]
	// A tool's result is stored on its call and follows the response.
	wantItems := []string{"user:count the tests", "reasoning", "call:call_1", "result:call_1=12 matches", "assistant:Twelve."}
	if got := tracetest.Summaries(first.Items); !reflect.DeepEqual(got, wantItems) {
		t.Errorf("items = %q\n want %q", got, wantItems)
	}
	// msg_4 was routed by Dari.
	wantTurns := []agents.Turn{{
		RequestID: agents.RequestID("opencode", "ses_1", "msg_2"), InputItems: 1, OutputItems: 2,
		Model: "pulse-alpha", Provider: "opencode",
		ReceivedAt: time.UnixMilli(1772413201000).UTC(), CompletedAt: time.UnixMilli(1772413203000).UTC(),
		StopReason: "tool_use",
		Usage:      agents.Usage{InputTokens: 20, OutputTokens: 4, CacheReadTokens: 50, CacheWriteTokens: 5},
	}}
	if !reflect.DeepEqual(first.Turns, wantTurns) {
		t.Errorf("turns = %+v\n want %+v", first.Turns, wantTurns)
	}
	if second := sessions[1]; second.SessionID != "ses_2" || second.Turns[0].Model != "openai/gpt-5.5" {
		t.Errorf("second session = %+v", second)
	}
}
