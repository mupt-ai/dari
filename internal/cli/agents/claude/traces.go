package claude

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// parseClaudeTranscript reads a Claude Code transcript: one line per message
// block, where the lines of one model response share its message ID.
func parseClaudeTranscript(path string, since time.Time) ([]agents.Session, error) {
	type block struct {
		Type      string          `json:"type"`
		Text      string          `json:"text"`
		Thinking  string          `json:"thinking"`
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Input     any             `json:"input"`
		ToolUseID string          `json:"tool_use_id"`
		Content   json.RawMessage `json:"content"`
	}
	type entry struct {
		Type             string    `json:"type"`
		SessionID        string    `json:"sessionId"`
		AgentID          string    `json:"agentId"`
		Timestamp        time.Time `json:"timestamp"`
		IsSidechain      bool      `json:"isSidechain"`
		IsCompactSummary bool      `json:"isCompactSummary"`
		Message          struct {
			ID         string          `json:"id"`
			Model      string          `json:"model"`
			Content    json.RawMessage `json:"content"`
			StopReason string          `json:"stop_reason"`
			Routing    json.RawMessage `json:"dari_routing"`
			Usage      struct {
				Input      int `json:"input_tokens"`
				Output     int `json:"output_tokens"`
				CacheRead  int `json:"cache_read_input_tokens"`
				CacheWrite int `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	builder := &agents.SessionBuilder{Since: since}
	// The response being read: its message ID, where its output ends, and its
	// turn's index (-1 when the turn is not imported).
	var open struct {
		id   string
		end  int
		turn int
	}
	var previous time.Time
	err := agents.ReadJSONLines(path, func(line []byte, _ int) {
		var e entry
		if json.Unmarshal(line, &e) != nil || (e.Type != "user" && e.Type != "assistant") {
			return
		}
		session := &builder.Session
		if session.SessionID == "" {
			session.Agent, session.SessionID, session.AgentID = "claude", e.SessionID, e.AgentID
		}
		// A subagent's thread has its own file; skip any written inline.
		if e.IsSidechain != (session.AgentID != "") {
			return
		}
		var blocks []block
		var text string
		if json.Unmarshal(e.Message.Content, &text) != nil {
			_ = json.Unmarshal(e.Message.Content, &blocks)
		}
		if e.Type == "user" {
			if e.IsCompactSummary {
				builder.Compact()
				open.id = ""
			}
			var texts []string
			if text != "" {
				texts = append(texts, text)
			}
			for _, b := range blocks {
				switch b.Type {
				case "tool_result":
					builder.Add(agents.ToolResultItem("function", b.ToolUseID, agents.ContentText(b.Content)))
				case "text":
					texts = append(texts, b.Text)
				case "image":
					texts = append(texts, "[image]")
				}
			}
			if len(texts) > 0 {
				builder.Add(agents.MessageItem("user", strings.Join(texts, "\n")))
			}
			previous = e.Timestamp
			return
		}
		// Claude Code writes its own error notices as synthetic assistant lines.
		if e.Message.Model == "<synthetic>" || e.Message.ID == "" {
			return
		}
		var output []agents.Item
		for _, b := range blocks {
			switch {
			case b.Type == "thinking" && b.Thinking != "":
				output = append(output, agents.ReasoningItem(b.Thinking))
			case b.Type == "text" && b.Text != "":
				output = append(output, agents.MessageItem("assistant", b.Text))
			case b.Type == "tool_use":
				output = append(output, agents.ToolCallItem("function", b.ID, b.Name, b.Input))
			}
		}
		if open.id != e.Message.ID {
			open.id, open.end, open.turn = e.Message.ID, len(session.Items), -1
			before := len(session.Turns)
			provider := "anthropic"
			if e.Message.Routing != nil {
				provider = "dari"
			}
			builder.Turn(e.Message.ID, agents.Turn{
				InputItems: len(session.Items),
				Model:      e.Message.Model,
				Provider:   provider,
				ReceivedAt: agents.FirstTime(previous, e.Timestamp),
			})
			if len(session.Turns) > before {
				open.turn = before
			}
		}
		// A tool can finish before the response's later blocks are written;
		// those blocks still belong before its result.
		if open.end == len(session.Items) {
			builder.Add(output...)
		} else {
			session.Items = append(session.Items[:open.end:open.end], append(output, session.Items[open.end:]...)...)
		}
		open.end += len(output)
		if open.turn >= 0 {
			turn := &session.Turns[open.turn]
			turn.OutputItems += len(output)
			turn.CompletedAt = e.Timestamp
			turn.StopReason = agents.StopReason(e.Message.StopReason)
			usage := e.Message.Usage
			turn.Usage = agents.Usage{InputTokens: usage.Input, OutputTokens: usage.Output, CacheReadTokens: usage.CacheRead, CacheWriteTokens: usage.CacheWrite}
		}
	})
	return builder.Finish(), err
}
