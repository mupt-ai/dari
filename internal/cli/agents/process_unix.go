//go:build unix

package agents

import "syscall"

// CanReplaceProcess reports whether a launch can run its agent in place of the
// launcher process.
const CanReplaceProcess = true

// ReplaceProcess runs path in the launcher's place. It returns only when the
// exec fails.
func ReplaceProcess(path string, argv, env []string) error {
	return syscall.Exec(path, argv, env)
}
