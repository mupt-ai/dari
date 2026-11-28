package pi

import (
	"encoding/json"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// parsePiSession reads a Pi session: one line per message, where each
// assistant message is one model response.
func parsePiSession(path string, since time.Time) ([]agents.Session, error) {
	type block struct {
		Type      string `json:"type"`
		Text      string `json:"text"`
		Thinking  string `json:"thinking"`
		ID        string `json:"id"`
		Name      string `json:"name"`
		Arguments any    `json:"arguments"`
	}
	type entry struct {
		Type      string    `json:"type"`
		ID        string    `json:"id"`
		Timestamp time.Time `json:"timestamp"`
		Summary   string    `json:"summary"`
		Message   struct {
			Role       string          `json:"role"`
			Content    json.RawMessage `json:"content"`
			Model      string          `json:"model"`
			Provider   string          `json:"provider"`
			StopReason string          `json:"stopReason"`
			Timestamp  int64           `json:"timestamp"`
			ToolCallID string          `json:"toolCallId"`
			Usage      struct {
				Input      int `json:"input"`
				Output     int `json:"output"`
				CacheRead  int `json:"cacheRead"`
				CacheWrite int `json:"cacheWrite"`
			} `json:"usage"`
		} `json:"message"`
	}
	builder := &agents.SessionBuilder{Since: since}
	session := &builder.Session
	err := agents.ReadJSONLines(path, func(line []byte, _ int) {
		var e entry
		if json.Unmarshal(line, &e) != nil {
			return
		}
		switch {
		case e.Type == "session" && session.SessionID == "":
			session.Agent, session.SessionID = "pi", e.ID
		case session.SessionID == "":
			// Not a session file.
		case e.Type == "compaction":
			builder.Compact()
			builder.Add(agents.MessageItem("user", e.Summary))
		case e.Type != "message":
		case e.Message.Role == "user" || e.Message.Role == "system":
			if text := agents.ContentText(e.Message.Content); text != "" {
				builder.Add(agents.MessageItem(e.Message.Role, text))
			}
		case e.Message.Role == "toolResult":
			builder.Add(agents.ToolResultItem("function", e.Message.ToolCallID, agents.ContentText(e.Message.Content)))
		case e.Message.Role == "assistant":
			var blocks []block
			_ = json.Unmarshal(e.Message.Content, &blocks)
			start := len(session.Items)
			for _, b := range blocks {
				switch {
				case b.Type == "thinking" && b.Thinking != "":
					builder.Add(agents.ReasoningItem(b.Thinking))
				case b.Type == "text" && b.Text != "":
					builder.Add(agents.MessageItem("assistant", b.Text))
				case b.Type == "toolCall":
					builder.Add(agents.ToolCallItem("function", b.ID, b.Name, b.Arguments))
				}
			}
			// A failed or interrupted response is not a served request.
			if e.Message.StopReason == "error" || e.Message.StopReason == "aborted" {
				return
			}
			usage := e.Message.Usage
			builder.Turn(e.ID, agents.Turn{
				InputItems:  start,
				OutputItems: len(session.Items) - start,
				Model:       e.Message.Model,
				Provider:    e.Message.Provider,
				ReceivedAt:  agents.FirstTime(agents.MillisTime(e.Message.Timestamp), e.Timestamp),
				CompletedAt: e.Timestamp,
				StopReason:  agents.StopReason(e.Message.StopReason),
				Usage:       agents.Usage{InputTokens: usage.Input, OutputTokens: usage.Output, CacheReadTokens: usage.CacheRead, CacheWriteTokens: usage.CacheWrite},
			})
		}
	})
	return builder.Finish(), err
}
