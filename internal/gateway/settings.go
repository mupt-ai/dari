// Package gateway holds where the coding agents route: the hosted Dari API, a
// Dari Gateway this CLI runs on this machine, or one the user runs elsewhere.
package gateway

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mupt-ai/dari/internal/state"
)

// Mode is where the coding agents route.
type Mode string

const (
	// ModeHosted routes through the hosted Dari API.
	ModeHosted Mode = "hosted"
	// ModeLocal routes through a gateway this CLI installs and runs on this
	// machine.
	ModeLocal Mode = "local"
	// ModeSelfHosted routes through a gateway the user runs elsewhere.
	ModeSelfHosted Mode = "self_hosted"
)

// Settings is the saved routing choice. URL and Key reach a self-hosted
// gateway. The rest belong to the local gateway and are kept while another
// mode is chosen, so returning to it changes nothing agents rely on: LocalKey
// is its generated client key, AutoRoutingKey the Dari API key it routes
// with, and ProviderKeys provider API keys by environment variable name.
type Settings struct {
	Mode           Mode              `json:"mode"`
	URL            string            `json:"url,omitempty"`
	Key            string            `json:"key,omitempty"`
	LocalKey       string            `json:"local_key,omitempty"`
	AutoRoutingKey string            `json:"auto_routing_key,omitempty"`
	ProviderKeys   map[string]string `json:"provider_keys,omitempty"`
}

// Dir is the gateway's directory beside the CLI state: settings, and a local
// gateway's binary, database, config, and log.
func Dir() (string, error) {
	statePath, err := state.Path()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(statePath), "gateway"), nil
}

func settingsPath() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}

// Load returns the saved settings, and false when none are saved.
func Load() (Settings, bool, error) {
	path, err := settingsPath()
	if err != nil {
		return Settings{}, false, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Settings{}, false, nil
	}
	if err != nil {
		return Settings{}, false, err
	}
	var settings Settings
	if err := json.Unmarshal(raw, &settings); err != nil {
		return Settings{}, false, fmt.Errorf("read %s: %w", path, err)
	}
	switch settings.Mode {
	case ModeHosted, ModeLocal, ModeSelfHosted:
	default:
		return Settings{}, false, fmt.Errorf("%s has unknown mode %q; run `dari gateway setup`", path, settings.Mode)
	}
	return settings, true, nil
}

// Save writes the settings, which hold secrets, readable only by the user.
func Save(settings Settings) error {
	path, err := settingsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// NewKey returns a random gateway key.
func NewKey() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "dgw_" + hex.EncodeToString(raw), nil
}
