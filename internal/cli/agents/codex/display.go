package codex

import (
	"context"
	"encoding/json"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type codexDisplaySession struct {
	ctx      context.Context
	cancel   context.CancelFunc
	socket   *websocket.Conn
	backend  *websocket.Conn
	writeMu  sync.Mutex
	mu       sync.Mutex
	statuses map[string]agents.Status
	dirty    map[string]bool
	wake     chan struct{}
}

func (b *codexStatusBridge) serveAppServer(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+b.token {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	// Reject browser-origin access even if the capability URL is disclosed.
	if r.Header.Get("Origin") != "" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	b.mu.Lock()
	if b.used || b.ctx.Err() != nil {
		b.mu.Unlock()
		http.Error(w, "Codex bridge already connected", http.StatusConflict)
		return
	}
	b.used = true
	b.handlers.Add(1)
	b.mu.Unlock()
	defer b.handlers.Done()
	defer func() {
		b.mu.Lock()
		b.used = false
		b.mu.Unlock()
	}()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	socket, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(b.ctx)
	defer cancel()
	backend, err := b.connectBackend()
	if err != nil {
		_ = socket.Close()
		return
	}
	session := &codexDisplaySession{
		ctx: ctx, cancel: cancel, socket: socket, backend: backend,
		statuses: make(map[string]agents.Status), dirty: make(map[string]bool), wake: make(chan struct{}, 1),
	}
	b.mu.Lock()
	if previous := b.session; previous != nil {
		previous.mu.Lock()
		for id, status := range previous.statuses {
			session.statuses[id] = status
		}
		previous.mu.Unlock()
	}
	b.session = session
	b.mu.Unlock()
	stop := context.AfterFunc(ctx, session.close)
	defer stop()
	defer session.close()
	socket.SetReadLimit(32 << 20)
	var workers sync.WaitGroup
	workers.Add(2)
	go func() { defer workers.Done(); session.forwardOutput() }()
	go func() { defer workers.Done(); session.publishStatus() }()
	for {
		kind, message, err := socket.ReadMessage()
		if err != nil {
			break
		}
		if kind != websocket.TextMessage {
			continue
		}
		if err = backend.WriteMessage(kind, message); err != nil {
			break
		}
	}
	session.close()
	workers.Wait()
}

func (s *codexDisplaySession) close() {
	s.cancel()
	_ = s.socket.Close()
	_ = s.backend.Close()
}

func (s *codexDisplaySession) send(message []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.socket.SetWriteDeadline(time.Now().Add(5 * time.Second))
	err := s.socket.WriteMessage(websocket.TextMessage, message)
	if err != nil {
		s.close()
	}
	return err
}

func (s *codexDisplaySession) update(threadID string, status agents.Status) {
	s.mu.Lock()
	if _, ok := s.statuses[threadID]; len(s.statuses) >= 512 && !ok {
		s.mu.Unlock()
		return
	}
	s.statuses[threadID] = status
	s.mu.Unlock()
	s.markDirty(threadID)
}

func (s *codexDisplaySession) markDirty(threadID string) {
	s.mu.Lock()
	s.dirty[threadID] = true
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *codexDisplaySession) publishStatus() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.wake:
			s.mu.Lock()
			updates := make([]string, 0, len(s.dirty))
			for id := range s.dirty {
				updates = append(updates, id)
			}
			clear(s.dirty)
			s.mu.Unlock()
			for _, id := range updates {
				if s.sendStatus(id) != nil {
					return
				}
			}
		}
	}
}

func (s *codexDisplaySession) sendStatus(threadID string) error {
	// Read the latest value only after owning the writer. An older restore
	// notification must never overtake a newer routing-header update.
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	text := s.statuses[threadID].String()
	s.mu.Unlock()
	if text == "" {
		return nil
	}
	body, _ := json.Marshal(map[string]any{
		"method": "thread/name/updated",
		"params": map[string]string{"threadId": threadID, "threadName": text},
	})
	_ = s.socket.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := s.socket.WriteMessage(websocket.TextMessage, body); err != nil {
		s.close()
		return err
	}
	return nil
}

func (s *codexDisplaySession) forwardOutput() {
	defer s.close()
	s.backend.SetReadLimit(32 << 20)
	for {
		_, message, err := s.backend.ReadMessage()
		if err != nil {
			return
		}
		if s.send(message) != nil {
			return
		}
		// Real names still reach the client, then the active thread's transient
		// status is restored. Start/resume/fork responses need the same treatment.
		if id := codexDisplayThread(message); id != "" {
			if s.sendStatus(id) != nil {
				return
			}
		}
	}
}

func codexDisplayThread(message []byte) string {
	var envelope struct {
		Method string `json:"method"`
		Params struct {
			ThreadID string `json:"threadId"`
			Thread   struct {
				ID string `json:"id"`
			} `json:"thread"`
		} `json:"params"`
		Result struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		} `json:"result"`
	}
	if json.Unmarshal(message, &envelope) != nil {
		return ""
	}
	if envelope.Method == "" {
		return envelope.Result.Thread.ID
	}
	switch envelope.Method {
	case "thread/started":
		return envelope.Params.Thread.ID
	case "thread/name/updated", "turn/started", "turn/completed":
		return envelope.Params.ThreadID
	default:
		return ""
	}
}
