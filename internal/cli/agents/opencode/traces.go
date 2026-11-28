package opencode

import (
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// openCodeSessions reads OpenCode's SQLite database through the sqlite3
// command, which keeps a database driver out of the CLI.
func openCodeSessions(path string, since time.Time, visit func(agents.Session) error) error {
	sqlite, err := exec.LookPath("sqlite3")
	if err != nil {
		return errors.New("reading OpenCode sessions needs the sqlite3 command")
	}
	output, err := exec.Command(sqlite, "-readonly", "-json", path,
		"select session_id, id, type, data from session_message order by session_id, seq").Output()
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	var messages []openCodeMessage
	if len(output) > 0 {
		if err := json.Unmarshal(output, &messages); err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
	}
	for _, session := range parseOpenCodeMessages(messages, since) {
		if err := visit(session); err != nil {
			return err
		}
	}
	return nil
}

// An openCodeMessage is one row of OpenCode's session_message table.
type openCodeMessage struct {
	SessionID string `json:"session_id"`
	ID        string `json:"id"`
	Type      string `json:"type"`
	Data      string `json:"data"`
}

// parseOpenCodeMessages reads OpenCode's messages, ordered by session and
// sequence: each assistant message is one model response, and holds the
// results of the tools it called.
func parseOpenCodeMessages(messages []openCodeMessage, since time.Time) []agents.Session {
	type data struct {
		Text    string `json:"text"`
		Content []struct {
			Type  string `json:"type"`
			Text  string `json:"text"`
			ID    string `json:"id"`
			Name  string `json:"name"`
			State struct {
				Input   any             `json:"input"`
				Content json.RawMessage `json:"content"`
			} `json:"state"`
		} `json:"content"`
		Finish string `json:"finish"`
		Model  struct {
			ID         string `json:"id"`
			ProviderID string `json:"providerID"`
		} `json:"model"`
		Time struct {
			Created   int64 `json:"created"`
			Completed int64 `json:"completed"`
		} `json:"time"`
		Tokens struct {
			Input  int `json:"input"`
			Output int `json:"output"`
			Cache  struct {
				Read  int `json:"read"`
				Write int `json:"write"`
			} `json:"cache"`
		} `json:"tokens"`
	}
	var sessions []agents.Session
	var builder *agents.SessionBuilder
	for _, message := range messages {
		if builder == nil || builder.Session.SessionID != message.SessionID {
			if builder != nil {
				sessions = append(sessions, builder.Finish()...)
			}
			builder = &agents.SessionBuilder{Since: since, Session: agents.Session{Agent: "opencode", SessionID: message.SessionID}}
		}
		var d data
		if json.Unmarshal([]byte(message.Data), &d) != nil {
			continue
		}
		session := &builder.Session
		switch message.Type {
		case "user", "synthetic":
			if d.Text != "" {
				builder.Add(agents.MessageItem("user", d.Text))
			}
		case "assistant":
			start := len(session.Items)
			var results []agents.Item
			for _, part := range d.Content {
				switch {
				case part.Type == "reasoning" && part.Text != "":
					builder.Add(agents.ReasoningItem(part.Text))
				case part.Type == "text" && part.Text != "":
					builder.Add(agents.MessageItem("assistant", part.Text))
				case part.Type == "tool":
					builder.Add(agents.ToolCallItem("function", part.ID, part.Name, part.State.Input))
					results = append(results, agents.ToolResultItem("function", part.ID, agents.ContentText(part.State.Content)))
				}
			}
			builder.Turn(message.ID, agents.Turn{
				InputItems:  start,
				OutputItems: len(session.Items) - start,
				Model:       d.Model.ID,
				Provider:    d.Model.ProviderID,
				ReceivedAt:  agents.MillisTime(d.Time.Created),
				CompletedAt: agents.MillisTime(d.Time.Completed),
				StopReason:  agents.StopReason(d.Finish),
				Usage:       agents.Usage{InputTokens: d.Tokens.Input, OutputTokens: d.Tokens.Output, CacheReadTokens: d.Tokens.Cache.Read, CacheWriteTokens: d.Tokens.Cache.Write},
			})
			builder.Add(results...)
		}
	}
	if builder != nil {
		sessions = append(sessions, builder.Finish()...)
	}
	return sessions
}
