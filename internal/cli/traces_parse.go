package cli

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// An importSession is one context window of a local agent session: the
// conversation in order, as the gateway's interaction items, and the model
// calls made in it. A session that was compacted is several of them, and a
// subagent's thread is its own, under its parent's session ID.
type importSession struct {
	Agent     string       `json:"agent"`
	SessionID string       `json:"session_id"`
	AgentID   string       `json:"agent_id,omitempty"`
	Items     []importItem `json:"items"`
	Turns     []importTurn `json:"turns"`
}

// An importTurn is one model call: the first InputItems items were its
// request, and the OutputItems after them its response.
type importTurn struct {
	RequestID   string      `json:"request_id"`
	InputItems  int         `json:"input_items"`
	OutputItems int         `json:"output_items"`
	Model       string      `json:"model"`
	Provider    string      `json:"provider"`
	ReceivedAt  time.Time   `json:"received_at"`
	CompletedAt time.Time   `json:"completed_at"`
	StopReason  string      `json:"stop_reason"`
	Usage       importUsage `json:"usage"`
}

// Input tokens exclude cache reads and writes.
type importUsage struct {
	InputTokens      int `json:"input_tokens"`
	OutputTokens     int `json:"output_tokens"`
	CacheReadTokens  int `json:"cache_read_tokens"`
	CacheWriteTokens int `json:"cache_write_tokens"`
}

type importItem = map[string]any

func messageItem(role, text string) importItem {
	return importItem{
		"type":         "message",
		"role":         role,
		"content":      []importItem{{"type": "text", "text": text}},
		"contentShape": "string",
	}
}

func reasoningItem(text string) importItem {
	return importItem{"type": "reasoning", "summary": []string{}, "content": []string{text}}
}

func toolCallItem(kind, callID, name string, input any) importItem {
	return importItem{"type": "tool_call", "callId": callID, "kind": kind, "name": name, "input": input}
}

func toolResultItem(kind, callID, output string) importItem {
	return importItem{"type": "tool_result", "callId": callID, "kind": kind, "output": output, "outputShape": "string"}
}

// importRequestID names a model call the same way on every run, so importing
// a session again stores nothing twice.
func importRequestID(agent, sessionID, entryID string) string {
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

// sessionBuilder collects a session's context windows as its transcript is read.
type sessionBuilder struct {
	since   time.Time
	session importSession
	done    []importSession
}

func (b *sessionBuilder) add(items ...importItem) {
	b.session.Items = append(b.session.Items, items...)
}

// turn records a model call, unless Dari routed it, it is older than --since,
// or its transcript does not say when it was made.
func (b *sessionBuilder) turn(entryID string, turn importTurn) {
	if routedByDari(turn.Provider, turn.Model) || turn.ReceivedAt.IsZero() || turn.ReceivedAt.Before(b.since) {
		return
	}
	if turn.CompletedAt.Before(turn.ReceivedAt) {
		turn.CompletedAt = turn.ReceivedAt
	}
	turn.Model = catalogModel(turn.Provider, turn.Model)
	turn.RequestID = importRequestID(b.session.Agent, b.session.SessionID, entryID)
	b.session.Turns = append(b.session.Turns, turn)
}

// compact starts a new context window: the agent replaced its history.
func (b *sessionBuilder) compact() {
	if len(b.session.Turns) > 0 {
		b.done = append(b.done, b.session)
	}
	b.session.Items, b.session.Turns = nil, nil
}

func (b *sessionBuilder) finish() []importSession {
	b.compact()
	if b.session.SessionID == "" {
		return nil
	}
	return b.done
}

// readJSONLines calls visit with each line of a JSONL file and its number.
// Transcript lines run to megabytes, past a Scanner's limit.
func readJSONLines(path string, visit func(line []byte, number int)) error {
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

// contentText reads message content that is a string or a list of parts,
// keeping its text. An image becomes a placeholder: Activity shows text.
func contentText(raw json.RawMessage) string {
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

// parseClaudeTranscript reads a Claude Code transcript: one line per message
// block, where the lines of one model response share its message ID.
func parseClaudeTranscript(path string, since time.Time) ([]importSession, error) {
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
	builder := &sessionBuilder{since: since}
	// The response being read: its message ID, where its output ends, and its
	// turn's index (-1 when the turn is not imported).
	var open struct {
		id   string
		end  int
		turn int
	}
	var previous time.Time
	err := readJSONLines(path, func(line []byte, _ int) {
		var e entry
		if json.Unmarshal(line, &e) != nil || (e.Type != "user" && e.Type != "assistant") {
			return
		}
		session := &builder.session
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
				builder.compact()
				open.id = ""
			}
			var texts []string
			if text != "" {
				texts = append(texts, text)
			}
			for _, b := range blocks {
				switch b.Type {
				case "tool_result":
					builder.add(toolResultItem("function", b.ToolUseID, contentText(b.Content)))
				case "text":
					texts = append(texts, b.Text)
				case "image":
					texts = append(texts, "[image]")
				}
			}
			if len(texts) > 0 {
				builder.add(messageItem("user", strings.Join(texts, "\n")))
			}
			previous = e.Timestamp
			return
		}
		// Claude Code writes its own error notices as synthetic assistant lines.
		if e.Message.Model == "<synthetic>" || e.Message.ID == "" {
			return
		}
		var output []importItem
		for _, b := range blocks {
			switch {
			case b.Type == "thinking" && b.Thinking != "":
				output = append(output, reasoningItem(b.Thinking))
			case b.Type == "text" && b.Text != "":
				output = append(output, messageItem("assistant", b.Text))
			case b.Type == "tool_use":
				output = append(output, toolCallItem("function", b.ID, b.Name, b.Input))
			}
		}
		if open.id != e.Message.ID {
			open.id, open.end, open.turn = e.Message.ID, len(session.Items), -1
			before := len(session.Turns)
			provider := "anthropic"
			if e.Message.Routing != nil {
				provider = "dari"
			}
			builder.turn(e.Message.ID, importTurn{
				InputItems: len(session.Items),
				Model:      e.Message.Model,
				Provider:   provider,
				ReceivedAt: firstTime(previous, e.Timestamp),
			})
			if len(session.Turns) > before {
				open.turn = before
			}
		}
		// A tool can finish before the response's later blocks are written;
		// those blocks still belong before its result.
		if open.end == len(session.Items) {
			builder.add(output...)
		} else {
			session.Items = append(session.Items[:open.end:open.end], append(output, session.Items[open.end:]...)...)
		}
		open.end += len(output)
		if open.turn >= 0 {
			turn := &session.Turns[open.turn]
			turn.OutputItems += len(output)
			turn.CompletedAt = e.Timestamp
			turn.StopReason = stopReason(e.Message.StopReason)
			usage := e.Message.Usage
			turn.Usage = importUsage{InputTokens: usage.Input, OutputTokens: usage.Output, CacheReadTokens: usage.CacheRead, CacheWriteTokens: usage.CacheWrite}
		}
	})
	return builder.finish(), err
}

func firstTime(times ...time.Time) time.Time {
	for _, t := range times {
		if !t.IsZero() {
			return t
		}
	}
	return time.Time{}
}

// millisTime reads an epoch-milliseconds timestamp; zero when absent.
func millisTime(millis int64) time.Time {
	if millis == 0 {
		return time.Time{}
	}
	return time.UnixMilli(millis).UTC()
}

// stopReason maps each agent's stop reason onto the gateway's.
func stopReason(reason string) string {
	switch reason {
	case "tool_use", "toolUse", "tool-calls":
		return "tool_use"
	case "max_tokens", "length":
		return "length"
	}
	return "stop"
}

// parseCodexRollout reads a Codex rollout: response items in order, with a
// usage record after each model response.
func parseCodexRollout(path string, since time.Time) ([]importSession, error) {
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
	err := readJSONLines(path, func(line []byte, number int) {
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
	builder := &sessionBuilder{since: since}
	session := &builder.session
	session.Agent = "codex"
	var provider, model string
	// The response being read: where its output starts and ends (-1 while it
	// is still being written).
	open := struct{ start, end int }{-1, -1}
	var previous, received time.Time
	item := func(p payload) (importItem, bool) {
		switch p.Type {
		case "message":
			if text := contentText(p.Content); text != "" {
				return messageItem(p.Role, text), p.Role == "assistant"
			}
		case "reasoning":
			if text := contentText(p.Summary); text != "" {
				return importItem{"type": "reasoning", "summary": []string{text}, "content": []string{}}, true
			}
		case "function_call":
			call := toolCallItem("function", p.CallID, p.Name, p.Arguments)
			if p.Namespace != "" {
				call["namespace"] = p.Namespace
			}
			return call, true
		case "custom_tool_call":
			return toolCallItem("custom", p.CallID, p.Name, p.Input), true
		case "function_call_output":
			return toolResultItem("function", p.CallID, contentText(p.Output)), false
		case "custom_tool_call_output":
			return toolResultItem("custom", p.CallID, contentText(p.Output)), false
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
			builder.compact()
			open.start, open.end = -1, -1
			for _, raw := range p.ReplacementHistory {
				var replaced payload
				if json.Unmarshal(raw, &replaced) == nil {
					if next, _ := item(replaced); next != nil {
						builder.add(next)
					}
				}
			}
			if len(p.ReplacementHistory) == 0 && p.Message != "" {
				builder.add(messageItem("user", p.Message))
			}
		case "response_item":
			next, output := item(p)
			if next == nil {
				continue
			}
			switch {
			case output && (open.start < 0 || open.end >= 0):
				open.start, open.end, received = len(session.Items), -1, firstTime(previous, r.Timestamp)
			case !output && open.start >= 0 && open.end < 0:
				open.end = len(session.Items)
			}
			builder.add(next)
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
			builder.turn(entryID, importTurn{
				InputItems:  open.start,
				OutputItems: end - open.start,
				Model:       model,
				Provider:    turnProvider,
				ReceivedAt:  received,
				CompletedAt: r.Timestamp,
				StopReason:  codexStopReason(session.Items[open.start:end]),
				Usage: importUsage{
					InputTokens:      max(0, used.Input-used.Cached-used.CacheWrite),
					OutputTokens:     used.Output,
					CacheReadTokens:  used.Cached,
					CacheWriteTokens: used.CacheWrite,
				},
			})
			open.start, open.end = -1, -1
		}
	}
	return builder.finish(), nil
}

// A Codex response that calls a tool stops for it.
func codexStopReason(output []importItem) string {
	for _, item := range output {
		if item["type"] == "tool_call" {
			return "tool_use"
		}
	}
	return "stop"
}

// parsePiSession reads a Pi session: one line per message, where each
// assistant message is one model response.
func parsePiSession(path string, since time.Time) ([]importSession, error) {
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
	builder := &sessionBuilder{since: since}
	session := &builder.session
	err := readJSONLines(path, func(line []byte, _ int) {
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
			builder.compact()
			builder.add(messageItem("user", e.Summary))
		case e.Type != "message":
		case e.Message.Role == "user" || e.Message.Role == "system":
			if text := contentText(e.Message.Content); text != "" {
				builder.add(messageItem(e.Message.Role, text))
			}
		case e.Message.Role == "toolResult":
			builder.add(toolResultItem("function", e.Message.ToolCallID, contentText(e.Message.Content)))
		case e.Message.Role == "assistant":
			var blocks []block
			_ = json.Unmarshal(e.Message.Content, &blocks)
			start := len(session.Items)
			for _, b := range blocks {
				switch {
				case b.Type == "thinking" && b.Thinking != "":
					builder.add(reasoningItem(b.Thinking))
				case b.Type == "text" && b.Text != "":
					builder.add(messageItem("assistant", b.Text))
				case b.Type == "toolCall":
					builder.add(toolCallItem("function", b.ID, b.Name, b.Arguments))
				}
			}
			// A failed or interrupted response is not a served request.
			if e.Message.StopReason == "error" || e.Message.StopReason == "aborted" {
				return
			}
			usage := e.Message.Usage
			builder.turn(e.ID, importTurn{
				InputItems:  start,
				OutputItems: len(session.Items) - start,
				Model:       e.Message.Model,
				Provider:    e.Message.Provider,
				ReceivedAt:  firstTime(millisTime(e.Message.Timestamp), e.Timestamp),
				CompletedAt: e.Timestamp,
				StopReason:  stopReason(e.Message.StopReason),
				Usage:       importUsage{InputTokens: usage.Input, OutputTokens: usage.Output, CacheReadTokens: usage.CacheRead, CacheWriteTokens: usage.CacheWrite},
			})
		}
	})
	return builder.finish(), err
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
func parseOpenCodeMessages(messages []openCodeMessage, since time.Time) []importSession {
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
	var sessions []importSession
	var builder *sessionBuilder
	for _, message := range messages {
		if builder == nil || builder.session.SessionID != message.SessionID {
			if builder != nil {
				sessions = append(sessions, builder.finish()...)
			}
			builder = &sessionBuilder{since: since, session: importSession{Agent: "opencode", SessionID: message.SessionID}}
		}
		var d data
		if json.Unmarshal([]byte(message.Data), &d) != nil {
			continue
		}
		session := &builder.session
		switch message.Type {
		case "user", "synthetic":
			if d.Text != "" {
				builder.add(messageItem("user", d.Text))
			}
		case "assistant":
			start := len(session.Items)
			var results []importItem
			for _, part := range d.Content {
				switch {
				case part.Type == "reasoning" && part.Text != "":
					builder.add(reasoningItem(part.Text))
				case part.Type == "text" && part.Text != "":
					builder.add(messageItem("assistant", part.Text))
				case part.Type == "tool":
					builder.add(toolCallItem("function", part.ID, part.Name, part.State.Input))
					results = append(results, toolResultItem("function", part.ID, contentText(part.State.Content)))
				}
			}
			builder.turn(message.ID, importTurn{
				InputItems:  start,
				OutputItems: len(session.Items) - start,
				Model:       d.Model.ID,
				Provider:    d.Model.ProviderID,
				ReceivedAt:  millisTime(d.Time.Created),
				CompletedAt: millisTime(d.Time.Completed),
				StopReason:  stopReason(d.Finish),
				Usage:       importUsage{InputTokens: d.Tokens.Input, OutputTokens: d.Tokens.Output, CacheReadTokens: d.Tokens.Cache.Read, CacheWriteTokens: d.Tokens.Cache.Write},
			})
			builder.add(results...)
		}
	}
	if builder != nil {
		sessions = append(sessions, builder.finish()...)
	}
	return sessions
}
