package codex

import (
	"bufio"
	"context"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A backend with stored names independent of the UI display notifications.
func mockCodexBackend(t *testing.T) *httptest.Server {
	t.Helper()
	name := "Fix Login Bug"
	var mu sync.Mutex
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		socket, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer socket.Close()
		for {
			var request struct {
				ID     int            `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if socket.ReadJSON(&request) != nil {
				return
			}
			mu.Lock()
			if request.Method == "thread/name/set" {
				name = request.Params["name"].(string)
			}
			var result any = map[string]any{}
			switch request.Method {
			case "thread/read", "thread/resume", "thread/fork", "thread/start":
				result = map[string]any{"thread": map[string]string{"id": "thread-main", "name": name}}
			case "thread/name/set":
				_ = socket.WriteJSON(map[string]any{"method": "thread/name/updated", "params": map[string]string{"threadId": "thread-main", "threadName": name}})
			case "test/usage":
				_ = socket.WriteJSON(map[string]any{"method": "thread/tokenUsage/updated", "params": map[string]any{"threadId": "thread-main", "turnId": "turn-1", "tokenUsage": map[string]any{"last": request.Params, "total": request.Params}}})
			}
			mu.Unlock()
			_ = socket.WriteJSON(map[string]any{"id": request.ID, "result": result})
		}
	}))
}

func TestCodexBridgeStreamsAndPreservesNames(t *testing.T) {
	flushed := make(chan struct{})
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/router/v1/responses" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("upstream request: %s auth=%t", r.URL.Path, r.Header.Get("Authorization") == "Bearer test-key")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"model":"dari/routing"}` {
			t.Errorf("body: %s", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("x-dari-selected-model", "test/served-model")
		w.Header().Set("x-dari-thinking-level", "high")
		w.Header().Set("x-dari-lease-turns-remaining", "1")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		close(flushed)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "data: last\n\n")
	}))
	defer upstream.Close()
	backend := mockCodexBackend(t)
	defer backend.Close()
	command := agents.Command{}
	bridge, err := newCodexStatusBridge(context.Background(), command, nil, "test-key", upstream.URL+"/router")
	if err != nil {
		t.Fatal(err)
	}
	bridge.backendURL = "ws" + strings.TrimPrefix(backend.URL, "http")
	defer bridge.close()
	base := "http://" + bridge.listener.Addr().String()
	wsURL := "ws://" + bridge.listener.Addr().String() + "/"
	for _, auth := range []string{"", "Bearer wrong-key", "Bearer " + bridge.token} {
		request, _ := http.NewRequest(http.MethodGet, base+"/v1/models", nil)
		request.Header.Set("Authorization", auth)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatal("routing proxy accepted without routing key", response.StatusCode)
		}
	}
	// An authenticated but invalid upgrade must not consume the only slot.
	badUpgrade, _ := http.NewRequest(http.MethodGet, base+"/", nil)
	badUpgrade.Header.Set("Authorization", "Bearer "+bridge.token)
	badResponse, err := http.DefaultClient.Do(badUpgrade)
	if err != nil {
		t.Fatal(err)
	}
	_ = badResponse.Body.Close()
	if badResponse.StatusCode == http.StatusSwitchingProtocols {
		t.Fatal("invalid upgrade accepted")
	}
	if _, response, err := websocket.DefaultDialer.Dial(wsURL, nil); err == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatal("unauthorized bridge connection accepted")
	}
	socket, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Authorization": []string{"Bearer " + bridge.token}})
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	read := func() map[string]any {
		t.Helper()
		_ = socket.SetReadDeadline(time.Now().Add(5 * time.Second))
		var message map[string]any
		if err := socket.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		return message
	}
	send := func(id int, method string, params map[string]any) {
		t.Helper()
		if err := socket.WriteJSON(map[string]any{"id": id, "method": method, "params": params}); err != nil {
			t.Fatal(err)
		}
	}
	send(1, "thread/read", map[string]any{})
	if name := read()["result"].(map[string]any)["thread"].(map[string]any)["name"]; name != "Fix Login Bug" {
		t.Fatal(name)
	}
	request, _ := http.NewRequest(http.MethodPost, base+"/v1/responses", strings.NewReader(`{"model":"dari/routing"}`))
	request.Header.Set("Authorization", "Bearer test-key")
	request.Header.Set("thread-id", "thread-main")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	select {
	case <-flushed:
	case <-time.After(5 * time.Second):
		t.Fatal("stream not flushed")
	}
	reader := bufio.NewReader(response.Body)
	if line, err := reader.ReadString('\n'); err != nil || line != "data: first\n" {
		t.Fatalf("stream: %q %v", line, err)
	}
	notice := read()
	if notice["method"] != "thread/name/updated" || notice["params"].(map[string]any)["threadName"] != "test/served-model · high · lease 2 turns left" {
		t.Fatal(notice)
	}
	close(release)
	if _, err := io.ReadAll(reader); err != nil {
		t.Fatal(err)
	}
	send(2, "thread/read", map[string]any{})
	if name := read()["result"].(map[string]any)["thread"].(map[string]any)["name"]; name != "Fix Login Bug" {
		t.Fatal("persisted status as name", name)
	}
	_ = read() // Restored transient status after thread/read.
	send(3, "thread/name/set", map[string]any{"name": "My New Title"})
	if read()["params"].(map[string]any)["threadName"] != "My New Title" {
		t.Fatal("rename was not forwarded")
	}
	_ = read() // Status restored after genuine name notification.
	_ = read() // Rename acknowledgment.
	send(4, "thread/resume", map[string]any{})
	if name := read()["result"].(map[string]any)["thread"].(map[string]any)["name"]; name != "My New Title" {
		t.Fatal(name)
	}
	if read()["params"].(map[string]any)["threadName"] != "test/served-model · high · lease 2 turns left" {
		t.Fatal("resume lost status")
	}
	bridge.mu.Lock()
	session := bridge.session
	bridge.mu.Unlock()
	session.mu.Lock()
	if session.statuses["thread-main"].Model == "" || session.statuses["other"].Model != "" {
		t.Fatal("thread status crossed sessions")
	}
	session.mu.Unlock()
	_ = socket.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		bridge.mu.Lock()
		busy := bridge.used
		bridge.mu.Unlock()
		if !busy {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("bridge did not release connection")
		}
		time.Sleep(time.Millisecond)
	}
	socket, _, err = websocket.DefaultDialer.Dial(wsURL, http.Header{"Authorization": []string{"Bearer " + bridge.token}})
	if err != nil {
		t.Fatal("reconnect failed", err)
	}
	defer socket.Close()
	send(5, "thread/resume", map[string]any{})
	if name := read()["result"].(map[string]any)["thread"].(map[string]any)["name"]; name != "My New Title" {
		t.Fatal("backend state lost on reconnect", name)
	}
	if read()["params"].(map[string]any)["threadName"] != "test/served-model · high · lease 2 turns left" {
		t.Fatal("reconnect lost status")
	}
}

func TestCodexBridgeIdentityAndIsolation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := &codexDisplaySession{ctx: ctx, statuses: map[string]agents.Status{}, dirty: map[string]bool{}, wake: make(chan struct{}, 1)}
	bridge := &codexStatusBridge{session: session}
	for _, tc := range []struct {
		threadID, metadata string
		status             int
		want               bool
	}{
		{"main", `{"thread_id":"main"}`, 200, true},
		{"conflict", `{"thread_id":"other"}`, 200, false},
		{"aux", `{"thread_id":"aux","request_kind":"memory"}`, 200, false},
		{"error", "", 500, false},
		{"", "", 200, false},
	} {
		request, _ := http.NewRequest(http.MethodPost, "http://test/v1/responses", nil)
		request.Header.Set("thread-id", tc.threadID)
		request.Header.Set("x-codex-turn-metadata", tc.metadata)
		response := &http.Response{StatusCode: tc.status, Request: request, Header: http.Header{}}
		response.Header.Set("x-dari-selected-model", "test/model")
		_ = bridge.observeRoutingResponse(response)
		if got := session.statuses[tc.threadID].Model != ""; got != tc.want {
			t.Errorf("%+v status=%v", tc, got)
		}
	}
}
