package agents

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Traces reads the sessions a coding agent keeps on this computer, for
// `dari traces import`.
type Traces struct {
	// Path is where the agent keeps its sessions.
	Path func() (string, error)
	// Sessions reads the sessions with model calls at or after since.
	Sessions func(path string, since time.Time, visit func(Session) error) error
}

// A Session is one context window of a local agent session: the
// conversation in order, as the gateway's interaction items, and the model
// calls made in it. A session that was compacted is several of them, and a
// subagent's thread is its own, under its parent's session ID.
type Session struct {
	Agent     string `json:"agent"`
	SessionID string `json:"session_id"`
	AgentID   string `json:"agent_id,omitempty"`
	Items     []Item `json:"items"`
	Turns     []Turn `json:"turns"`
}

// A Turn is one model call: the first InputItems items were its
// request, and the OutputItems after them its response.
type Turn struct {
	RequestID   string    `json:"request_id"`
	InputItems  int       `json:"input_items"`
	OutputItems int       `json:"output_items"`
	Model       string    `json:"model"`
	Provider    string    `json:"provider"`
	ReceivedAt  time.Time `json:"received_at"`
	CompletedAt time.Time `json:"completed_at"`
	StopReason  string    `json:"stop_reason"`
	Usage       Usage     `json:"usage"`
}

// Input tokens exclude cache reads and writes.
type Usage struct {
	InputTokens      int `json:"input_tokens"`
	OutputTokens     int `json:"output_tokens"`
	CacheReadTokens  int `json:"cache_read_tokens"`
	CacheWriteTokens int `json:"cache_write_tokens"`
}

type Item = map[string]any

func MessageItem(role, text string) Item {
	return Item{
		"type":         "message",
		"role":         role,
		"content":      []Item{{"type": "text", "text": text}},
		"contentShape": "string",
	}
}

func ReasoningItem(text string) Item {
	return Item{"type": "reasoning", "summary": []string{}, "content": []string{text}}
}

func ToolCallItem(kind, callID, name string, input any) Item {
	return Item{"type": "tool_call", "callId": callID, "kind": kind, "name": name, "input": input}
}

func ToolResultItem(kind, callID, output string) Item {
	return Item{"type": "tool_result", "callId": callID, "kind": kind, "output": output, "outputShape": "string"}
}

// RequestID names a model call the same way on every run, so importing
// a session again stores nothing twice.
func RequestID(agent, sessionID, entryID string) string {
	sum := sha256.Sum256([]byte(agent + "\x00" + sessionID + "\x00" + entryID))
	return "imp_" + hex.EncodeToString(sum[:16])
}

// routedByDari reports a model call Dari served, which Activity already has.
func routedByDari(provider, model string) bool {
	return provider == "dari" || strings.HasPrefix(provider, "dari-") || strings.HasPrefix(model, "dari/")
}

// catalogModel names a model the way Dari's catalog does, under its owner.
func catalogModel(provider, model string) string {
	switch {
	case model == "" || strings.Contains(model, "/"):
		return model
	case provider == "anthropic":
		return "anthropic/" + model
	case strings.HasPrefix(provider, "openai"):
		return "openai/" + model
	}
	return model
}

// SessionBuilder collects a session's context windows as its transcript is read.
type SessionBuilder struct {
	// Since is the --since cutoff: older model calls are left out.
	Since   time.Time
	Session Session
	done    []Session
}

// Add appends items to the conversation.
func (b *SessionBuilder) Add(items ...Item) {
	b.Session.Items = append(b.Session.Items, items...)
}

// Turn records a model call, unless Dari routed it, it is older than --since,
// or its transcript does not say when it was made.
func (b *SessionBuilder) Turn(entryID string, turn Turn) {
	if routedByDari(turn.Provider, turn.Model) || turn.ReceivedAt.IsZero() || turn.ReceivedAt.Before(b.Since) {
		return
	}
	if turn.CompletedAt.Before(turn.ReceivedAt) {
		turn.CompletedAt = turn.ReceivedAt
	}
	turn.Model = catalogModel(turn.Provider, turn.Model)
	turn.RequestID = RequestID(b.Session.Agent, b.Session.SessionID, entryID)
	b.Session.Turns = append(b.Session.Turns, turn)
}

// Compact starts a new context window: the agent replaced its history.
func (b *SessionBuilder) Compact() {
	if len(b.Session.Turns) > 0 {
		b.done = append(b.done, b.Session)
	}
	b.Session.Items, b.Session.Turns = nil, nil
}

// Finish closes the last context window and returns the session's windows.
func (b *SessionBuilder) Finish() []Session {
	b.Compact()
	if b.Session.SessionID == "" {
		return nil
	}
	return b.done
}

// ReadJSONLines calls visit with each line of a JSONL file and its number.
// Transcript lines run to megabytes, past a Scanner's limit.
func ReadJSONLines(path string, visit func(line []byte, number int)) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 1<<20)
	for number := 1; ; number++ {
		line, err := reader.ReadBytes('\n')
		if len(line) > 1 {
			visit(line, number)
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// contentPart is a block of message content in any agent's transcript.
type contentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// ContentText reads message content that is a string or a list of parts,
// keeping its text. An image becomes a placeholder: Activity shows text.
func ContentText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []contentPart
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var texts []string
	for _, part := range parts {
		switch {
		case part.Text != "":
			texts = append(texts, part.Text)
		case strings.Contains(part.Type, "image"):
			texts = append(texts, "[image]")
		}
	}
	return strings.Join(texts, "\n")
}

// FirstTime is the first of times that is set.
func FirstTime(times ...time.Time) time.Time {
	for _, t := range times {
		if !t.IsZero() {
			return t
		}
	}
	return time.Time{}
}

// MillisTime reads an epoch-milliseconds timestamp; zero when absent.
func MillisTime(millis int64) time.Time {
	if millis == 0 {
		return time.Time{}
	}
	return time.UnixMilli(millis).UTC()
}

// StopReason maps each agent's stop reason onto the gateway's.
func StopReason(reason string) string {
	switch reason {
	case "tool_use", "toolUse", "tool-calls":
		return "tool_use"
	case "max_tokens", "length":
		return "length"
	}
	return "stop"
}

// TranscriptFiles reads every transcript under a directory whose name matches
// and that changed since the cutoff.
func TranscriptFiles(parse func(path string, since time.Time) ([]Session, error), pattern string) func(string, time.Time, func(Session) error) error {
	return func(root string, since time.Time, visit func(Session) error) error {
		return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			if matched, _ := filepath.Match(pattern, entry.Name()); !matched {
				return nil
			}
			if info, err := entry.Info(); err != nil || info.ModTime().Before(since) {
				return err
			}
			sessions, err := parse(path, since)
			if err != nil {
				return fmt.Errorf("read %s: %w", path, err)
			}
			for _, session := range sessions {
				if err := visit(session); err != nil {
					return err
				}
			}
			return nil
		})
	}
}
