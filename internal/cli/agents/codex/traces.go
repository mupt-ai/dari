package codex

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// parseCodexRollout reads a Codex rollout: response items in order, with a
// usage record after each model response.
func parseCodexRollout(path string, since time.Time) ([]agents.Session, error) {
	type record struct {
		Type      string          `json:"type"`
		Timestamp time.Time       `json:"timestamp"`
		Payload   json.RawMessage `json:"payload"`
		line      int
	}
	type usage struct {
		Input      int `json:"input_tokens"`
		Cached     int `json:"cached_input_tokens"`
		CacheWrite int `json:"cache_write_input_tokens"`
		Output     int `json:"output_tokens"`
	}
	type payload struct {
		Type          string          `json:"type"`
		ID            string          `json:"id"`
		ModelProvider string          `json:"model_provider"`
		Model         string          `json:"model"`
		Role          string          `json:"role"`
		Content       json.RawMessage `json:"content"`
		Summary       json.RawMessage `json:"summary"`
		CallID        string          `json:"call_id"`
		Name          string          `json:"name"`
		Namespace     string          `json:"namespace"`
		Arguments     string          `json:"arguments"`
		Input         string          `json:"input"`
		Output        json.RawMessage `json:"output"`
		ResponseID    string          `json:"response_id"`
		Usage         *usage          `json:"usage"`
		Info          *struct {
			Last *usage `json:"last_token_usage"`
		} `json:"info"`
		Message            string            `json:"message"`
		ReplacementHistory []json.RawMessage `json:"replacement_history"`
	}
	var records []record
	// Newer rollouts carry a usage record per response; older ones only the
	// token counts the interface showed.
	usageRecord := "event_msg"
	err := agents.ReadJSONLines(path, func(line []byte, number int) {
		var r record
		if json.Unmarshal(line, &r) != nil {
			return
		}
		r.line = number
		if r.Type == "token_usage_record" {
			usageRecord = r.Type
		}
		records = append(records, r)
	})
	if err != nil {
		return nil, err
	}
	builder := &agents.SessionBuilder{Since: since}
	session := &builder.Session
	session.Agent = "codex"
	var provider, model string
	// The response being read: where its output starts and ends (-1 while it
	// is still being written).
	open := struct{ start, end int }{-1, -1}
	var previous, received time.Time
	item := func(p payload) (agents.Item, bool) {
		switch p.Type {
		case "message":
			if text := agents.ContentText(p.Content); text != "" {
				return agents.MessageItem(p.Role, text), p.Role == "assistant"
			}
		case "reasoning":
			if text := agents.ContentText(p.Summary); text != "" {
				return agents.Item{"type": "reasoning", "summary": []string{text}, "content": []string{}}, true
			}
		case "function_call":
			call := agents.ToolCallItem("function", p.CallID, p.Name, p.Arguments)
			if p.Namespace != "" {
				call["namespace"] = p.Namespace
			}
			return call, true
		case "custom_tool_call":
			return agents.ToolCallItem("custom", p.CallID, p.Name, p.Input), true
		case "function_call_output":
			return agents.ToolResultItem("function", p.CallID, agents.ContentText(p.Output)), false
		case "custom_tool_call_output":
			return agents.ToolResultItem("custom", p.CallID, agents.ContentText(p.Output)), false
		}
		return nil, false
	}
	for _, r := range records {
		var p payload
		if json.Unmarshal(r.Payload, &p) != nil {
			continue
		}
		switch r.Type {
		case "session_meta":
			if session.SessionID == "" {
				session.SessionID, provider = p.ID, p.ModelProvider
			}
		case "turn_context":
			model = p.Model
		case "compacted":
			builder.Compact()
			open.start, open.end = -1, -1
			for _, raw := range p.ReplacementHistory {
				var replaced payload
				if json.Unmarshal(raw, &replaced) == nil {
					if next, _ := item(replaced); next != nil {
						builder.Add(next)
					}
				}
			}
			if len(p.ReplacementHistory) == 0 && p.Message != "" {
				builder.Add(agents.MessageItem("user", p.Message))
			}
		case "response_item":
			next, output := item(p)
			if next == nil {
				continue
			}
			switch {
			case output && (open.start < 0 || open.end >= 0):
				open.start, open.end, received = len(session.Items), -1, agents.FirstTime(previous, r.Timestamp)
			case !output && open.start >= 0 && open.end < 0:
				open.end = len(session.Items)
			}
			builder.Add(next)
			previous = r.Timestamp
		case usageRecord:
			used := p.Usage
			if r.Type == "event_msg" {
				if p.Type != "token_count" || p.Info == nil {
					continue
				}
				used = p.Info.Last
			}
			if used == nil || open.start < 0 {
				continue
			}
			end := open.end
			if end < 0 {
				end = len(session.Items)
			}
			entryID := p.ResponseID
			if entryID == "" {
				entryID = "line:" + strconv.Itoa(r.line)
			}
			turnProvider := "openai"
			if provider == "dari" {
				turnProvider = provider
			}
			builder.Turn(entryID, agents.Turn{
				InputItems:  open.start,
				OutputItems: end - open.start,
				Model:       model,
				Provider:    turnProvider,
				ReceivedAt:  received,
				CompletedAt: r.Timestamp,
				StopReason:  codexStopReason(session.Items[open.start:end]),
				Usage: agents.Usage{
					InputTokens:      max(0, used.Input-used.Cached-used.CacheWrite),
					OutputTokens:     used.Output,
					CacheReadTokens:  used.Cached,
					CacheWriteTokens: used.CacheWrite,
				},
			})
			open.start, open.end = -1, -1
		}
	}
	return builder.Finish(), nil
}

// A Codex response that calls a tool stops for it.
func codexStopReason(output []agents.Item) string {
	for _, item := range output {
		if item["type"] == "tool_call" {
			return "tool_use"
		}
	}
	return "stop"
}
