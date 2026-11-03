//go:build !unix

package agents

import "errors"

// CanReplaceProcess reports whether a launch can run its agent in place of the
// launcher process.
const CanReplaceProcess = false

// ReplaceProcess is never called where CanReplaceProcess is false.
func ReplaceProcess(string, []string, []string) error {
	return errors.ErrUnsupported
}
