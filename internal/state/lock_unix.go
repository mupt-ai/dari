//go:build unix

package state

import (
	"os"

	"golang.org/x/sys/unix"
)

func lock(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	for {
		err := unix.Flock(int(file.Fd()), unix.LOCK_EX)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			file.Close()
			return nil, err
		}
		break
	}
	return func() {
		_ = unix.Flock(int(file.Fd()), unix.LOCK_UN)
		_ = file.Close()
	}, nil
}
