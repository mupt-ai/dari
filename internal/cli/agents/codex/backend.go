package codex

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/gorilla/websocket"
)

// Keep the backend alive across UI reconnects so active turns aren't killed.
// Each UI connection gets a fresh authenticated Codex protocol connection.
func (b *codexStatusBridge) connectBackend() (*websocket.Conn, error) {
	b.backendMu.Lock()
	defer b.backendMu.Unlock()
	if b.ctx.Err() != nil {
		return nil, b.ctx.Err()
	}
	if b.backendDone != nil {
		select {
		case <-b.backendDone:
			_ = os.Remove(b.backendTokenPath)
			b.backendURL = ""
			b.backendTokenPath = ""
			b.backendDone = nil
		default:
		}
	}
	if b.backendURL == "" {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		address := "ws://" + listener.Addr().String()
		_ = listener.Close()
		file, err := os.CreateTemp("", "dari-codex-token-*")
		if err != nil {
			return nil, err
		}
		path := file.Name()
		_, err = file.WriteString(b.token)
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			_ = os.Remove(path)
			return nil, err
		}
		args := append([]string{}, b.serverArgs...)
		args = append(args, "--listen", address, "--ws-auth", "capability-token", "--ws-token-file", path)
		command := exec.CommandContext(b.ctx, b.command.Path, args...)
		command.Env = b.command.Env
		command.Dir = b.directory
		command.Stderr = io.Discard
		cleanup, err := startCodexAppServerProcess(command)
		if err != nil {
			_ = os.Remove(path)
			return nil, err
		}
		b.backendURL = address
		b.backendTokenPath = path
		done := make(chan struct{})
		b.backendDone = done
		go func() {
			_ = command.Wait()
			cleanup()
			close(done)
		}()
	}
	dialer := websocket.Dialer{HandshakeTimeout: time.Second}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	retry := time.NewTicker(50 * time.Millisecond)
	defer retry.Stop()
	for {
		socket, response, err := dialer.DialContext(b.ctx, b.backendURL, http.Header{"Authorization": []string{"Bearer " + b.token}})
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		if err == nil {
			return socket, nil
		}
		select {
		case <-b.ctx.Done():
			return nil, b.ctx.Err()
		case <-b.backendDone:
			return nil, fmt.Errorf("Codex app-server exited before connecting")
		case <-deadline.C:
			return nil, fmt.Errorf("timed out connecting to Codex app-server")
		case <-retry.C:
		}
	}
}
