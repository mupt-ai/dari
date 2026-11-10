//go:build unix

package state

import (
	"os"
	"path/filepath"
)

func replaceFile(source, destination string) error {
	if err := os.Rename(source, destination); err != nil {
		return err
	}
	// The replacement is complete. Directory syncing is best effort: returning
	// an error here would tell callers their update failed after it was saved.
	dir, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return nil
	}
	defer dir.Close()
	_ = dir.Sync()
	return nil
}
