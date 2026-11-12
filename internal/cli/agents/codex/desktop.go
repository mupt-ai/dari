package codex

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// The Codex app reads only ~/.codex/config.toml, so setup writes Dari there
// between markers and comments out the top-level keys it replaces. Removing
// setup deletes the marked blocks and restores those keys.
const (
	setupBegin    = "# >>> dari codex --setup >>>"
	setupEnd      = "# <<< dari codex --setup <<<"
	setupDisabled = "# dari codex --setup: "
	catalogFile   = "dari-models.json"
)

// profile is replaced too: a named profile's model and provider would
// override the Dari block written at the root.
var replacedKeys = []string{"model", "model_provider", "profile", "model_catalog_json", "model_reasoning_summary"}

// SavedModel is the top-level model in home's config.toml, which Codex's
// /model sets, or "" when there is none.
func SavedModel(home string) string {
	config, err := readConfig(filepath.Join(home, "config.toml"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(config, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			return ""
		}
		name, value, ok := strings.Cut(trimmed, "=")
		if !ok || strings.TrimSpace(name) != "model" {
			continue
		}
		model, err := strconv.Unquote(strings.TrimSpace(value))
		if err != nil {
			return ""
		}
		return model
	}
	return ""
}

// IsSetUp reports whether home's config.toml has Dari set up in it.
func IsSetUp(home string) bool {
	config, err := readConfig(filepath.Join(home, "config.toml"))
	return err == nil && strings.Contains(config, setupBegin)
}

// Home is the Codex config directory: CODEX_HOME, or ~/.codex.
func Home() (string, error) {
	if home := strings.TrimSpace(os.Getenv("CODEX_HOME")); home != "" {
		return home, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home directory: %w", err)
	}
	return filepath.Join(home, ".codex"), nil
}

// Setup makes Dari the default provider in home's config.toml, with the
// catalog from Catalog as the model menu. The key is written inline because
// the Codex app does not inherit shell environment variables.
func Setup(home, baseURL, key, model string, catalog []byte, disableWebSearch bool) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("create Codex config directory: %w", err)
	}
	catalogPath := filepath.Join(home, catalogFile)
	if err := os.WriteFile(catalogPath, catalog, 0o600); err != nil {
		return fmt.Errorf("write Codex model catalog: %w", err)
	}
	path := filepath.Join(home, "config.toml")
	existing, err := readConfig(path)
	if err != nil {
		return err
	}
	config, err := setupConfig(existing, baseURL, key, model, catalogPath, disableWebSearch)
	if err != nil {
		return err
	}
	return writeConfig(path, config)
}

// RemoveSetup undoes Setup and reports whether there was anything to remove.
func RemoveSetup(home string) (bool, error) {
	path := filepath.Join(home, "config.toml")
	existing, err := readConfig(path)
	if err != nil {
		return false, err
	}
	// Codex refuses to start while model_catalog_json names a missing file, so
	// the config stops naming the catalog before the catalog goes, including a
	// line left outside the markers after they were lost.
	catalogPath := filepath.Join(home, catalogFile)
	config := withoutCatalog(removeSetup(existing), catalogPath)
	removed := config != existing
	if removed && strings.TrimSpace(config) == "" {
		if err := os.Remove(path); err != nil {
			return false, fmt.Errorf("remove Codex config: %w", err)
		}
	} else if removed {
		if err := writeConfig(path, config); err != nil {
			return false, err
		}
	}
	catalogErr := os.Remove(catalogPath)
	if catalogErr != nil && !errors.Is(catalogErr, os.ErrNotExist) {
		return false, fmt.Errorf("remove Codex model catalog: %w", catalogErr)
	}
	return removed || catalogErr == nil, nil
}

// withoutCatalog drops the lines that point model_catalog_json at catalogPath.
func withoutCatalog(config, catalogPath string) string {
	var kept []string
	for _, line := range strings.Split(config, "\n") {
		trimmed := strings.TrimSpace(line)
		_, value, _ := strings.Cut(trimmed, "=")
		if path, err := strconv.Unquote(strings.TrimSpace(value)); err == nil && path == catalogPath &&
			replacesKey(trimmed, []string{"model_catalog_json"}) {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func setupConfig(existing, baseURL, key, model, catalogPath string, disableWebSearch bool) (string, error) {
	replaced := replacedKeys
	if disableWebSearch {
		replaced = append(slices.Clone(replacedKeys), "web_search")
	}
	lines := strings.Split(removeSetup(existing), "\n")
	inTable := false
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			inTable = true
			if table := tableName(trimmed); table == "model_providers.dari" || strings.HasPrefix(table, "model_providers.dari.") {
				return "", fmt.Errorf("Codex config already defines [%s]; remove it, then run setup again", table)
			}
		}
		if !inTable && replacesKey(trimmed, replaced) {
			lines[i] = setupDisabled + line
		}
	}
	top := []string{
		setupBegin,
		"model = " + strconv.Quote(model),
		`model_provider = "dari"`,
		"model_catalog_json = " + strconv.Quote(catalogPath),
		`model_reasoning_summary = "none"`,
	}
	if disableWebSearch {
		top = append(top, `web_search = "disabled"`)
	}
	top = append(top, setupEnd)
	provider := []string{
		setupBegin,
		"[model_providers.dari]",
		`name = "Dari"`,
		"base_url = " + strconv.Quote(baseURL+"/v1"),
		"experimental_bearer_token = " + strconv.Quote(key),
		`wire_api = "responses"`,
		setupEnd,
	}
	rest := strings.TrimRight(strings.Join(lines, "\n"), "\n")
	config := strings.Join(top, "\n") + "\n"
	if rest != "" {
		config += rest + "\n\n"
	}
	return config + strings.Join(provider, "\n") + "\n", nil
}

// tableName returns the dotted name of a table header such as
// `[model_providers."dari"] # note`, without spaces or quotes.
func tableName(header string) string {
	name := strings.TrimPrefix(header, "[")
	name, _, _ = strings.Cut(strings.TrimPrefix(name, "["), "]")
	name = strings.Join(strings.Fields(name), "")
	return strings.NewReplacer(`"`, "", "'", "").Replace(name)
}

func replacesKey(line string, keys []string) bool {
	name, _, ok := strings.Cut(line, "=")
	if !ok {
		return false
	}
	name = strings.Trim(strings.TrimSpace(name), `"'`)
	return slices.Contains(keys, name)
}

func removeSetup(config string) string {
	var kept []string
	inBlock := false
	for _, line := range strings.Split(config, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case line == setupBegin:
			inBlock = true
		case line == setupEnd:
			inBlock = false
		// Codex appends tables it adds (its /model, its [tui] state) at the end
		// of the file, inside the trailing block; they are Codex's, not setup's.
		case inBlock && strings.HasPrefix(trimmed, "[") && tableName(trimmed) != "model_providers.dari":
			inBlock = false
			kept = append(kept, line)
		case inBlock:
		default:
			kept = append(kept, strings.TrimPrefix(line, setupDisabled))
		}
	}
	result := strings.Join(kept, "\n")
	if result == config {
		return config
	}
	return strings.TrimLeft(strings.TrimRight(result, "\n")+"\n", "\n")
}

func readConfig(path string) (string, error) {
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read Codex config: %w", err)
	}
	return string(body), nil
}

func writeConfig(path, config string) error {
	temp := path + ".dari-tmp"
	if err := os.WriteFile(temp, []byte(config), 0o600); err != nil {
		return fmt.Errorf("write Codex config: %w", err)
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return fmt.Errorf("write Codex config: %w", err)
	}
	return nil
}
