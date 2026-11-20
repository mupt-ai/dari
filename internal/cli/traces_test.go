package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The transcripts below are synthetic: each has the shape of the lines its
// agent writes, with made-up content.

const claudeTranscript = `{"type":"mode","mode":"default","sessionId":"sess-claude"}
{"type":"user","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-02T01:00:00.000Z","message":{"role":"user","content":"list the files"}}
{"type":"assistant","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-02T01:00:02.000Z","message":{"id":"msg_1","model":"claude-opus-4-8","role":"assistant","content":[{"type":"thinking","thinking":"two listings"}],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}
{"type":"assistant","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-02T01:00:03.000Z","message":{"id":"msg_1","model":"claude-opus-4-8","role":"assistant","content":[{"type":"tool_use","id":"toolu_a","name":"Bash","input":{"command":"ls"}}],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}
{"type":"user","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-02T01:00:03.500Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_a","content":"README.md"}]}}
{"type":"assistant","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-02T01:00:04.000Z","message":{"id":"msg_1","model":"claude-opus-4-8","role":"assistant","content":[{"type":"tool_use","id":"toolu_b","name":"Bash","input":{"command":"ls src"}}],"stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}}
{"type":"user","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-02T01:00:05.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_b","content":[{"type":"text","text":"main.go"},{"type":"image","source":{"type":"base64","data":"AAAA"}}]}]}}
{"type":"assistant","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-02T01:00:06.000Z","message":{"id":"msg_2","model":"anthropic/claude-opus-4-8","role":"assistant","content":[{"type":"text","text":"Two files."}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2},"dari_routing":{"request_id":"rreq_1"}}}
{"type":"assistant","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-02T01:00:06.500Z","message":{"id":"err_1","model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"API Error"}]}}
{"type":"user","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-02T01:00:07.000Z","message":{"role":"user","content":[{"type":"text","text":"thanks"}]}}
{"type":"assistant","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-02T01:00:08.000Z","message":{"id":"msg_3","model":"claude-opus-4-8","role":"assistant","content":[{"type":"text","text":"Welcome."}],"stop_reason":"end_turn","usage":{"input_tokens":4,"output_tokens":1}}}
{"type":"user","sessionId":"sess-claude","isSidechain":false,"isCompactSummary":true,"timestamp":"2026-03-03T01:00:00.000Z","message":{"role":"user","content":"Summary of the session so far."}}
{"type":"assistant","sessionId":"sess-claude","isSidechain":false,"timestamp":"2026-03-03T01:00:01.000Z","message":{"id":"msg_4","model":"claude-opus-4-8","role":"assistant","content":[{"type":"text","text":"Continuing."}],"stop_reason":"max_tokens","usage":{"input_tokens":6,"output_tokens":2}}}
`

const claudeSubagentTranscript = `{"type":"user","sessionId":"sess-claude","agentId":"agent-a","isSidechain":true,"timestamp":"2026-03-02T02:00:00.000Z","message":{"role":"user","content":"review the diff"}}
{"type":"assistant","sessionId":"sess-claude","agentId":"agent-a","isSidechain":true,"timestamp":"2026-03-02T02:00:01.000Z","message":{"id":"msg_sub","model":"claude-haiku-4-5","role":"assistant","content":[{"type":"text","text":"Looks right."}],"stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":3}}}
`

const codexRollout = `{"timestamp":"2026-03-02T01:00:00.000Z","type":"session_meta","payload":{"id":"sess-codex","session_id":"sess-codex","model_provider":"openai","base_instructions":{"text":"be brief"}}}
{"timestamp":"2026-03-02T01:00:00.100Z","type":"turn_context","payload":{"model":"gpt-5.5","effort":"medium","summary":"auto"}}
{"timestamp":"2026-03-02T01:00:00.200Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"rules"}]}}
{"timestamp":"2026-03-02T01:00:00.300Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the bug"}]}}
{"timestamp":"2026-03-02T01:00:01.000Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"look first"}],"content":null,"encrypted_content":"opaque"}}
{"timestamp":"2026-03-02T01:00:02.000Z","type":"response_item","payload":{"type":"function_call","call_id":"call_1","name":"exec","namespace":"shell","arguments":"{\"cmd\":\"ls\"}"}}
{"timestamp":"2026-03-02T01:00:02.100Z","type":"token_usage_record","payload":{"response_id":"resp_1","usage":{"input_tokens":150,"cached_input_tokens":100,"cache_write_input_tokens":20,"output_tokens":7,"total_tokens":157}}}
{"timestamp":"2026-03-02T01:00:02.500Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":[{"type":"input_text","text":"bug.go"}]}}
{"timestamp":"2026-03-02T01:00:02.600Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":150,"cached_input_tokens":100,"output_tokens":7}}}}
{"timestamp":"2026-03-02T01:00:03.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_2","name":"apply_patch","input":"*** Begin Patch"}}
{"timestamp":"2026-03-02T01:00:03.100Z","type":"token_usage_record","payload":{"response_id":"resp_2","usage":{"input_tokens":30,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":4,"total_tokens":34}}}
{"timestamp":"2026-03-02T01:00:03.500Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_2","output":"Done"}}
{"timestamp":"2026-03-02T01:00:04.000Z","type":"compacted","payload":{"message":"","replacement_history":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Summary so far."}]}]}}
{"timestamp":"2026-03-02T01:00:05.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixed."}]}}
{"timestamp":"2026-03-02T01:00:05.100Z","type":"token_usage_record","payload":{"response_id":"resp_3","usage":{"input_tokens":9,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":2,"total_tokens":11}}}
`

// A rollout from before usage records: the token count the interface showed
// closes each response.
const codexLegacyRollout = `{"timestamp":"2026-03-02T01:00:00.000Z","type":"session_meta","payload":{"id":"sess-legacy","model_provider":"openai"}}
{"timestamp":"2026-03-02T01:00:00.100Z","type":"turn_context","payload":{"model":"gpt-5.5"}}
{"timestamp":"2026-03-02T01:00:00.300Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"timestamp":"2026-03-02T01:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}
{"timestamp":"2026-03-02T01:00:01.100Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":12,"cached_input_tokens":2,"output_tokens":1}}}}
`

const codexRoutedRollout = `{"timestamp":"2026-03-02T01:00:00.000Z","type":"session_meta","payload":{"id":"sess-routed","model_provider":"dari"}}
{"timestamp":"2026-03-02T01:00:00.100Z","type":"turn_context","payload":{"model":"dari/routing"}}
{"timestamp":"2026-03-02T01:00:00.300Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"timestamp":"2026-03-02T01:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}
{"timestamp":"2026-03-02T01:00:01.100Z","type":"token_usage_record","payload":{"response_id":"resp_r","usage":{"input_tokens":12,"output_tokens":1}}}
`

const piSession = `{"type":"session","version":3,"id":"sess-pi","timestamp":"2026-03-02T01:00:00.000Z","cwd":"/work"}
{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-03-02T01:00:00.000Z","provider":"openai-codex","modelId":"gpt-5.5"}
{"type":"message","id":"e1","parentId":"m1","timestamp":"2026-03-02T01:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"read the config"}],"timestamp":1772413201000}}
{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-03-02T01:00:03.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"open it","thinkingSignature":"sig"},{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"config.yml"}}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.5","stopReason":"toolUse","timestamp":1772413201500,"usage":{"input":11,"output":6,"cacheRead":90,"cacheWrite":0,"totalTokens":107,"cost":{"total":0.01}}}}
{"type":"message","id":"e3","parentId":"e2","timestamp":"2026-03-02T01:00:03.500Z","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"port: 80"}],"isError":false,"timestamp":1772413203500}}
{"type":"message","id":"e4","parentId":"e3","timestamp":"2026-03-02T01:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Port 80."}],"api":"openai-completions","provider":"dari","model":"dari/routing","stopReason":"stop","timestamp":1772413204000,"usage":{"input":5,"output":2,"cacheRead":0,"cacheWrite":0}}}
{"type":"message","id":"e5","parentId":"e4","timestamp":"2026-03-02T01:00:06.000Z","message":{"role":"user","content":"and the host?","timestamp":1772413206000}}
{"type":"message","id":"e6","parentId":"e5","timestamp":"2026-03-02T01:00:07.000Z","message":{"role":"assistant","content":[],"provider":"anthropic","model":"claude-opus-4-8","stopReason":"error","timestamp":1772413206500,"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}}
{"type":"message","id":"e7","parentId":"e6","timestamp":"2026-03-02T01:00:09.000Z","message":{"role":"assistant","content":[{"type":"text","text":"localhost"}],"provider":"anthropic","model":"claude-opus-4-8","stopReason":"stop","timestamp":1772413208000,"usage":{"input":8,"output":1,"cacheRead":0,"cacheWrite":30}}}
{"type":"compaction","id":"e8","parentId":"e7","timestamp":"2026-03-02T02:00:00.000Z","summary":"The config was read.","firstKeptEntryId":"e7","tokensBefore":1000}
{"type":"message","id":"e9","parentId":"e8","timestamp":"2026-03-02T02:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Anything else?"}],"provider":"ollama","model":"gemma4:31b","stopReason":"length","timestamp":1772416801000,"usage":{"input":3,"output":3,"cacheRead":0,"cacheWrite":0}}}
`

func writeTranscript(t *testing.T, content string, path ...string) string {
	t.Helper()
	file := filepath.Join(append([]string{t.TempDir()}, path...)...)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

// itemSummaries names each item briefly, in order.
func itemSummaries(items []importItem) []string {
	summaries := make([]string, len(items))
	for i, item := range items {
		switch item["type"] {
		case "message":
			summaries[i] = item["role"].(string) + ":" + item["content"].([]importItem)[0]["text"].(string)
		case "reasoning":
			summaries[i] = "reasoning"
		case "tool_call":
			summaries[i] = "call:" + item["callId"].(string)
		case "tool_result":
			summaries[i] = "result:" + item["callId"].(string) + "=" + item["output"].(string)
		}
	}
	return summaries
}

func instant(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestParseClaudeTranscript(t *testing.T) {
	path := writeTranscript(t, claudeTranscript, "sess-claude.jsonl")
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
	if got := itemSummaries(first.Items); !reflect.DeepEqual(got, wantItems) {
		t.Errorf("items = %q\n want %q", got, wantItems)
	}
	// msg_2 was routed by Dari and the synthetic notice is not a model call.
	wantTurns := []importTurn{
		{
			RequestID: importRequestID("claude", "sess-claude", "msg_1"), InputItems: 1, OutputItems: 3,
			Model: "anthropic/claude-opus-4-8", Provider: "anthropic",
			ReceivedAt: instant(t, "2026-03-02T01:00:00Z"), CompletedAt: instant(t, "2026-03-02T01:00:04Z"),
			StopReason: "tool_use",
			Usage:      importUsage{InputTokens: 10, OutputTokens: 5, CacheReadTokens: 100, CacheWriteTokens: 20},
		},
		{
			RequestID: importRequestID("claude", "sess-claude", "msg_3"), InputItems: 8, OutputItems: 1,
			Model: "anthropic/claude-opus-4-8", Provider: "anthropic",
			ReceivedAt: instant(t, "2026-03-02T01:00:07Z"), CompletedAt: instant(t, "2026-03-02T01:00:08Z"),
			StopReason: "stop",
			Usage:      importUsage{InputTokens: 4, OutputTokens: 1},
		},
	}
	if !reflect.DeepEqual(first.Turns, wantTurns) {
		t.Errorf("turns = %+v\n want %+v", first.Turns, wantTurns)
	}
	second := sessions[1]
	if got := itemSummaries(second.Items); !reflect.DeepEqual(got, []string{"user:Summary of the session so far.", "assistant:Continuing."}) {
		t.Errorf("items after compaction = %q", got)
	}
	if len(second.Turns) != 1 || second.Turns[0].InputItems != 1 || second.Turns[0].StopReason != "length" {
		t.Errorf("turns after compaction = %+v", second.Turns)
	}

	since, err := parseClaudeTranscript(path, instant(t, "2026-03-03T00:00:00Z"))
	if err != nil {
		t.Fatal(err)
	}
	if len(since) != 1 || since[0].Turns[0].RequestID != second.Turns[0].RequestID {
		t.Errorf("since the compaction = %+v", since)
	}
}

func TestParseClaudeSubagentTranscript(t *testing.T) {
	path := writeTranscript(t, claudeSubagentTranscript, "sess-claude", "subagents", "agent-a.jsonl")
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

func TestParseCodexRollout(t *testing.T) {
	sessions, err := parseCodexRollout(writeTranscript(t, codexRollout, "rollout-1.jsonl"), time.Time{})
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
	if got := itemSummaries(first.Items); !reflect.DeepEqual(got, wantItems) {
		t.Errorf("items = %q\n want %q", got, wantItems)
	}
	if call := first.Items[3]; call["namespace"] != "shell" || call["input"] != `{"cmd":"ls"}` || first.Items[5]["kind"] != "custom" {
		t.Errorf("tool calls = %v, %v", call, first.Items[5])
	}
	wantTurns := []importTurn{
		{
			RequestID: importRequestID("codex", "sess-codex", "resp_1"), InputItems: 2, OutputItems: 2,
			Model: "openai/gpt-5.5", Provider: "openai",
			ReceivedAt: instant(t, "2026-03-02T01:00:00.3Z"), CompletedAt: instant(t, "2026-03-02T01:00:02.1Z"),
			StopReason: "tool_use",
			// The transcript's input count includes its cache reads and writes.
			Usage: importUsage{InputTokens: 30, OutputTokens: 7, CacheReadTokens: 100, CacheWriteTokens: 20},
		},
		{
			RequestID: importRequestID("codex", "sess-codex", "resp_2"), InputItems: 5, OutputItems: 1,
			Model: "openai/gpt-5.5", Provider: "openai",
			ReceivedAt: instant(t, "2026-03-02T01:00:02.5Z"), CompletedAt: instant(t, "2026-03-02T01:00:03.1Z"),
			StopReason: "tool_use",
			Usage:      importUsage{InputTokens: 30, OutputTokens: 4},
		},
	}
	if !reflect.DeepEqual(first.Turns, wantTurns) {
		t.Errorf("turns = %+v\n want %+v", first.Turns, wantTurns)
	}
	second := sessions[1]
	if got := itemSummaries(second.Items); !reflect.DeepEqual(got, []string{"user:Summary so far.", "assistant:Fixed."}) {
		t.Errorf("items after compaction = %q", got)
	}
	if len(second.Turns) != 1 || second.Turns[0].InputItems != 1 || second.Turns[0].StopReason != "stop" {
		t.Errorf("turns after compaction = %+v", second.Turns)
	}
}

func TestParseCodexRolloutWithoutUsageRecords(t *testing.T) {
	sessions, err := parseCodexRollout(writeTranscript(t, codexLegacyRollout, "rollout-1.jsonl"), time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || len(sessions[0].Turns) != 1 {
		t.Fatalf("sessions = %+v", sessions)
	}
	turn := sessions[0].Turns[0]
	// With no response ID, the usage line's number names the call.
	if turn.RequestID != importRequestID("codex", "sess-legacy", "line:5") || turn.Usage != (importUsage{InputTokens: 10, OutputTokens: 1, CacheReadTokens: 2}) {
		t.Errorf("turn = %+v", turn)
	}
}

func TestParseCodexRolloutSkipsDariRoutedSessions(t *testing.T) {
	sessions, err := parseCodexRollout(writeTranscript(t, codexRoutedRollout, "rollout-1.jsonl"), time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 0 {
		t.Errorf("sessions = %+v, want none", sessions)
	}
}

func TestParsePiSession(t *testing.T) {
	sessions, err := parsePiSession(writeTranscript(t, piSession, "session.jsonl"), time.Time{})
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
	if got := itemSummaries(first.Items); !reflect.DeepEqual(got, wantItems) {
		t.Errorf("items = %q\n want %q", got, wantItems)
	}
	// e4 was routed by Dari and e6 failed.
	wantTurns := []importTurn{
		{
			RequestID: importRequestID("pi", "sess-pi", "e2"), InputItems: 1, OutputItems: 2,
			Model: "openai/gpt-5.5", Provider: "openai-codex",
			ReceivedAt: instant(t, "2026-03-02T01:00:01.5Z"), CompletedAt: instant(t, "2026-03-02T01:00:03Z"),
			StopReason: "tool_use",
			Usage:      importUsage{InputTokens: 11, OutputTokens: 6, CacheReadTokens: 90},
		},
		{
			RequestID: importRequestID("pi", "sess-pi", "e7"), InputItems: 6, OutputItems: 1,
			Model: "anthropic/claude-opus-4-8", Provider: "anthropic",
			ReceivedAt: instant(t, "2026-03-02T01:00:08Z"), CompletedAt: instant(t, "2026-03-02T01:00:09Z"),
			StopReason: "stop",
			Usage:      importUsage{InputTokens: 8, OutputTokens: 1, CacheWriteTokens: 30},
		},
	}
	if !reflect.DeepEqual(first.Turns, wantTurns) {
		t.Errorf("turns = %+v\n want %+v", first.Turns, wantTurns)
	}
	second := sessions[1]
	if got := itemSummaries(second.Items); !reflect.DeepEqual(got, []string{"user:The config was read.", "assistant:Anything else?"}) {
		t.Errorf("items after compaction = %q", got)
	}
	// A model no catalog owner is known for keeps its own name.
	if turn := second.Turns[0]; turn.Model != "gemma4:31b" || turn.Provider != "ollama" || turn.StopReason != "length" {
		t.Errorf("turn after compaction = %+v", turn)
	}
}

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
	if got := itemSummaries(first.Items); !reflect.DeepEqual(got, wantItems) {
		t.Errorf("items = %q\n want %q", got, wantItems)
	}
	// msg_4 was routed by Dari.
	wantTurns := []importTurn{{
		RequestID: importRequestID("opencode", "ses_1", "msg_2"), InputItems: 1, OutputItems: 2,
		Model: "pulse-alpha", Provider: "opencode",
		ReceivedAt: time.UnixMilli(1772413201000).UTC(), CompletedAt: time.UnixMilli(1772413203000).UTC(),
		StopReason: "tool_use",
		Usage:      importUsage{InputTokens: 20, OutputTokens: 4, CacheReadTokens: 50, CacheWriteTokens: 5},
	}}
	if !reflect.DeepEqual(first.Turns, wantTurns) {
		t.Errorf("turns = %+v\n want %+v", first.Turns, wantTurns)
	}
	if second := sessions[1]; second.SessionID != "ses_2" || second.Turns[0].Model != "openai/gpt-5.5" {
		t.Errorf("second session = %+v", second)
	}
}

// useAgentHomes points every agent's session storage at a temporary home
// holding the synthetic transcripts.
func useAgentHomes(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	write := func(content string, path ...string) {
		file := filepath.Join(append([]string{home}, path...)...)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(claudeTranscript, "claude", "projects", "-work", "sess-claude.jsonl")
	write(claudeSubagentTranscript, "claude", "projects", "-work", "sess-claude", "subagents", "agent-a.jsonl")
	write(codexRollout, "codex", "sessions", "2026", "03", "02", "rollout-2026-03-02-sess-codex.jsonl")
	write(codexRoutedRollout, "codex", "sessions", "2026", "03", "02", "rollout-2026-03-02-sess-routed.jsonl")
	write(piSession, "pi", "sessions", "--work--", "2026-03-02_sess-pi.jsonl")
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, "claude"))
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Join(home, "pi"))
	// No OpenCode database lives here.
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
}

func runTracesImport(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := newRootCmd("dev")
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(append([]string{"traces", "import"}, args...))
	err := cmd.Execute()
	return out.String(), err
}

func TestTracesImportDryRunCountsEachAgent(t *testing.T) {
	useAgentHomes(t)
	// A dry run reads no credentials and sends nothing.
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	out, err := runTracesImport(t, "--dry-run")
	if err != nil {
		t.Fatal(err)
	}
	want := "" +
		"Agent         Sessions     Turns\n" +
		"Claude Code          1         4\n" +
		"Codex                1         3\n" +
		"Pi                   1         3\n"
	if out != want {
		t.Errorf("output =\n%s\nwant\n%s", out, want)
	}

	out, err = runTracesImport(t, "--dry-run", "--agent", "claude", "--since", "2026-03-03T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if want := "Agent         Sessions     Turns\nClaude Code          1         1\n"; out != want {
		t.Errorf("output since =\n%s\nwant\n%s", out, want)
	}

	if _, err := runTracesImport(t, "--dry-run", "--agent", "opencode"); err == nil || !strings.Contains(err.Error(), "no OpenCode sessions at") {
		t.Errorf("missing agent error = %v", err)
	}
	if _, err := runTracesImport(t, "--dry-run", "--agent", "cursor"); err == nil || !strings.Contains(err.Error(), "expected claude, codex, opencode, pi") {
		t.Errorf("unknown agent error = %v", err)
	}
	if _, err := runTracesImport(t, "--dry-run", "--since", "last week"); err == nil || !strings.Contains(err.Error(), "invalid --since") {
		t.Errorf("bad since error = %v", err)
	}
}

func TestTracesImportUploadsEachSession(t *testing.T) {
	useAgentHomes(t)
	var uploaded []importSession
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/organizations/current/routing/activity/imports" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer dari_test" {
			t.Errorf("Authorization = %q", got)
		}
		var session importSession
		if err := json.NewDecoder(r.Body).Decode(&session); err != nil {
			t.Error(err)
		}
		uploaded = append(uploaded, session)
		// The subagent's call was imported by an earlier run.
		imported := len(session.Turns)
		if session.AgentID != "" {
			imported = 0
		}
		_ = json.NewEncoder(w).Encode(map[string]int{"imported": imported, "existing": len(session.Turns) - imported})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	out, err := runTracesImport(t, "--api-url", srv.URL, "--agent", "claude")
	if err != nil {
		t.Fatal(err)
	}
	want := "" +
		"Agent         Sessions     Turns  Imported\n" +
		"Claude Code          1         4         3\n"
	if out != want {
		t.Errorf("output =\n%s\nwant\n%s", out, want)
	}
	// One request per context window and per subagent thread, each with the
	// conversation up to its last call.
	if len(uploaded) != 3 {
		t.Fatalf("uploads = %d, want 3", len(uploaded))
	}
	for _, session := range uploaded {
		last := session.Turns[len(session.Turns)-1]
		if session.Agent != "claude" || session.SessionID != "sess-claude" || len(session.Items) != last.InputItems+last.OutputItems {
			t.Errorf("upload = %+v", session)
		}
	}
}

func TestImportSessionRequestsBoundsEachRequest(t *testing.T) {
	session := importSession{Agent: "pi", SessionID: "sess"}
	for i := 0; i < importTurnsPerRequest+5; i++ {
		session.Items = append(session.Items, messageItem("user", "next"), messageItem("assistant", "ok"))
		session.Turns = append(session.Turns, importTurn{InputItems: 2*i + 1, OutputItems: 1})
	}
	// The last call's conversation is too large for one request.
	session.Items = append(session.Items, messageItem("user", strings.Repeat("x", importMaxRequestBytes)), messageItem("assistant", "ok"))
	session.Turns = append(session.Turns, importTurn{InputItems: len(session.Items) - 1, OutputItems: 1})

	var sent [][2]int
	imported, tooLarge, err := importSessionRequests(session, func(body []byte) (int, error) {
		var request importSession
		if err := json.Unmarshal(body, &request); err != nil {
			return 0, err
		}
		sent = append(sent, [2]int{len(request.Turns), len(request.Items)})
		return len(request.Turns), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if imported != importTurnsPerRequest+5 || tooLarge != 1 {
		t.Errorf("imported = %d, too large = %d", imported, tooLarge)
	}
	// 25 calls, then the 5 that fit one at a time once the oversized call
	// shares their request, and the oversized call itself is left out.
	want := [][2]int{{importTurnsPerRequest, 2 * importTurnsPerRequest}}
	for i := importTurnsPerRequest; i < importTurnsPerRequest+5; i++ {
		want = append(want, [2]int{1, 2 * (i + 1)})
	}
	if !reflect.DeepEqual(sent, want) {
		t.Errorf("requests = %v, want %v", sent, want)
	}
}
