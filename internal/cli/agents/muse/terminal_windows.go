//go:build windows

package muse

import "os/exec"

// run starts Muse Code directly: Windows consoles get no status row.
func (b *statusBar) run(cmd *exec.Cmd) error {
	return cmd.Run()
}
