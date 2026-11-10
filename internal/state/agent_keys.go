package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

const agentKeysFilename = "agent-keys.json"

type agentKeysFile struct {
	SchemaVersion int               `json:"schema_version"`
	RoutingKeys   map[string]string `json:"routing_keys"`
}

// EnsureRoutingKey returns the cached key for a launcher scope, or issues and
// atomically caches one while holding the cross-process key-file lock.
func EnsureRoutingKey(scope string, issue func() (string, error)) (string, bool, error) {
	path, err := agentKeysPath()
	if err != nil {
		return "", false, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", false, fmt.Errorf("create state dir: %w", err)
	}

	unlock, err := lock(path + ".lock")
	if err != nil {
		return "", false, fmt.Errorf("lock agent keys: %w", err)
	}
	defer unlock()

	keys, err := loadAgentKeys(path)
	if err != nil {
		return "", false, err
	}
	if key := keys.RoutingKeys[scope]; key != "" {
		return key, false, nil
	}
	key, err := issue()
	if err != nil {
		return "", false, err
	}
	if key == "" {
		return "", false, errors.New("cannot cache an empty Routing key")
	}
	keys.RoutingKeys[scope] = key
	if err := saveAgentKeys(path, keys); err != nil {
		return "", false, err
	}
	return key, true, nil
}

func agentKeysPath() (string, error) {
	statePath, err := Path()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(statePath), agentKeysFilename), nil
}

func loadAgentKeys(path string) (agentKeysFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return agentKeysFile{
				SchemaVersion: SchemaVersion,
				RoutingKeys:   map[string]string{},
			}, nil
		}
		return agentKeysFile{}, fmt.Errorf("read agent keys: %w", err)
	}

	var keys agentKeysFile
	if err := json.Unmarshal(data, &keys); err != nil {
		return agentKeysFile{}, fmt.Errorf("parse agent keys: %w", err)
	}
	if keys.SchemaVersion != SchemaVersion {
		return agentKeysFile{}, fmt.Errorf("unsupported Dari agent key schema version: %d", keys.SchemaVersion)
	}
	if keys.RoutingKeys == nil {
		keys.RoutingKeys = map[string]string{}
	}
	return keys, nil
}

func saveAgentKeys(path string, keys agentKeysFile) error {
	data, err := json.MarshalIndent(keys, "", "  ")
	if err != nil {
		return fmt.Errorf("encode agent keys: %w", err)
	}
	data = append(data, '\n')

	perm := os.FileMode(0o644)
	if runtime.GOOS != "windows" {
		perm = 0o600
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".agent-keys-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary agent keys: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return fmt.Errorf("set agent key permissions: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write temporary agent keys: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temporary agent keys: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temporary agent keys: %w", err)
	}
	if err := replaceFile(tmpPath, path); err != nil {
		return fmt.Errorf("replace agent keys: %w", err)
	}
	return nil
}
