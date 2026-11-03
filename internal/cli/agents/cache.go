package agents

import (
	"fmt"
	"os"
	"path/filepath"
)

// WriteCacheFile stores content at name under Dari's directory in the user's
// cache and returns the file's path. A launch rewrites the file in full, through
// a rename, so it never depends on what an earlier launch left behind and a
// concurrent launch never reads a partial file.
func WriteCacheFile(name, content string) (string, error) {
	root, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("locate cache directory: %w", err)
	}
	path := filepath.Join(root, "dari", filepath.FromSlash(name))
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create cache directory: %w", err)
	}
	file, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return "", fmt.Errorf("create %s: %w", name, err)
	}
	tmp := file.Name()
	if err := writeAndClose(file, content); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("write %s: %w", name, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("write %s: %w", name, err)
	}
	return path, nil
}

func writeAndClose(file *os.File, content string) error {
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
