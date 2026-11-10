//go:build !darwin && !linux

package auth

import (
	"context"
	"errors"
	"os"
	"time"
)

const supportsCallbackPolling = false

func (cb *callbackServer) waitFileInput(context.Context, *os.File, time.Duration) (CallbackResult, error) {
	return CallbackResult{}, errors.New("callback input polling is unsupported on this platform")
}
