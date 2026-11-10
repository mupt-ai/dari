//go:build unix

package gateway

import (
	"os/exec"
	"syscall"
)

// detach starts cmd in its own session, so it outlives the launching terminal.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
