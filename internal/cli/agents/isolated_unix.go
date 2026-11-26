//go:build !windows

package agents

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func ShutdownSignals() []os.Signal {
	return []os.Signal{syscall.SIGTERM, syscall.SIGHUP}
}

func StartIsolatedProcess(command *exec.Cmd) (func(), error) {
	isolateProcess(command)
	if err := command.Start(); err != nil {
		return nil, err
	}
	return func() { killProcessGroup(command) }, nil
}

// Only the foreground TUI receives Ctrl-C. Cancel the entire isolated group,
// including tool children, when the launcher exits or its terminal hangs up.
func isolateProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	command.WaitDelay = 2 * time.Second
}

func killProcessGroup(command *exec.Cmd) {
	if command.Process != nil {
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	}
}
