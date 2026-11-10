//go:build darwin || linux

package auth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const supportsCallbackPolling = true

// Poll in the calling goroutine so returning from browser login leaves no
// blocked stdin reader behind. Read a byte at a time to preserve input for the
// next prompt or coding agent, including bytes after a pasted callback URL.
func (cb *callbackServer) waitFileInput(ctx context.Context, file *os.File, timeout time.Duration) (CallbackResult, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	var line []byte
	eof := false
	for {
		select {
		case res := <-cb.result:
			return res.check()
		case <-ctx.Done():
			return CallbackResult{}, ctx.Err()
		case <-deadline.C:
			return CallbackResult{}, errors.New("timed out waiting for browser login to complete")
		default:
		}
		fds := []unix.PollFd{{Fd: int32(file.Fd()), Events: unix.POLLIN}}
		if eof {
			fds = nil
		}
		n, err := unix.Poll(fds, 25)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return CallbackResult{}, fmt.Errorf("poll callback input: %w", err)
		}
		if n == 0 {
			continue
		}
		if fds[0].Revents&unix.POLLNVAL != 0 {
			return CallbackResult{}, errors.New("callback input is closed")
		}
		var b [1]byte
		n, err = unix.Read(int(file.Fd()), b[:])
		if errors.Is(err, unix.EINTR) || errors.Is(err, unix.EAGAIN) {
			continue
		}
		if err != nil {
			return CallbackResult{}, fmt.Errorf("read callback URL: %w", err)
		}
		if n == 0 {
			if len(line) > 0 {
				return ParseCallbackURL(string(line))
			}
			eof = true
			continue
		}
		if b[0] == '\n' {
			if strings.TrimSpace(string(line)) == "" {
				line = line[:0]
				continue
			}
			return ParseCallbackURL(string(line))
		}
		line = append(line, b[0])
		if len(line) > 64*1024 {
			return CallbackResult{}, errors.New("callback URL is too long")
		}
	}
}
