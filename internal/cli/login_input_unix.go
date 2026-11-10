//go:build darwin || linux

package cli

import (
	"errors"
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// loginInputPolling reports whether the login page can watch the keyboard
// while it waits for the browser.
const loginInputPolling = true

// loginPollInterval bounds how long a page redraw waits for input, so the
// spinner keeps moving and the callback is noticed promptly.
const loginPollInterval = 25 * time.Millisecond

// pollLoginInput returns the bytes typed since the last call, or nil once
// timeout passes. It polls in the calling goroutine so leaving the login page
// never strands a reader that would eat the next prompt's or coding agent's
// input.
func pollLoginInput(file *os.File, timeout time.Duration) ([]byte, error) {
	fds := []unix.PollFd{{Fd: int32(file.Fd()), Events: unix.POLLIN}}
	n, err := unix.Poll(fds, int(timeout.Milliseconds()))
	if errors.Is(err, unix.EINTR) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("poll login input: %w", err)
	}
	if n == 0 {
		return nil, nil
	}
	if fds[0].Revents&unix.POLLIN == 0 {
		if fds[0].Revents&(unix.POLLHUP|unix.POLLERR|unix.POLLNVAL) != 0 {
			return nil, errors.New("login input is closed")
		}
		return nil, nil
	}
	buf := make([]byte, 256)
	n, err = unix.Read(int(file.Fd()), buf)
	if errors.Is(err, unix.EINTR) || errors.Is(err, unix.EAGAIN) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read login input: %w", err)
	}
	return buf[:n], nil
}
