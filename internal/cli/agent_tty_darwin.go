package cli

import "golang.org/x/sys/unix"

// discardAgentInput drops keys typed while no page was reading, so a stray
// enter cannot answer the next page.
func discardAgentInput(fd int) {
	if termios, err := unix.IoctlGetTermios(fd, unix.TIOCGETA); err == nil {
		_ = unix.IoctlSetTermios(fd, unix.TIOCSETAF, termios)
	}
}
