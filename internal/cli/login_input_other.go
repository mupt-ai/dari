//go:build !darwin && !linux

package cli

import (
	"errors"
	"os"
	"time"
)

// loginInputPolling is false where the login page cannot watch the keyboard
// while it waits, so browser login falls back to plain text.
const loginInputPolling = false

func pollLoginInput(*os.File, time.Duration) ([]byte, error) {
	return nil, errors.New("interactive login input polling is unsupported on this platform")
}
