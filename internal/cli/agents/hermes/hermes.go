// Package hermes sets Hermes Agent up to route through Dari. Hermes runs its
// chats, messaging platforms, and scheduled tasks in a shared gateway that
// reads config.yaml, so Dari is written there rather than into a single
// launch: a "dari" entry under providers, made the main model.
package hermes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

const (
	providerID = "dari"
	// setupFile, beside config.yaml, keeps the main-model settings Dari
	// replaced so removing setup can restore them.
	setupFile = "dari-setup.json"
)

// replacedKeys are the model settings that would otherwise steer Dari's
// route: another endpoint, key, wire format, or context window.
var replacedKeys = []string{"provider", "default", "base_url", "api_key", "api_mode", "context_length"}

type savedSetup struct {
	Model map[string]any `json:"model"`
}

// ConfigPath asks Hermes for its config file, which follows HERMES_HOME and
// the active profile.
func ConfigPath(ctx context.Context, executable string) (string, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, executable, "config", "path")
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			return "", fmt.Errorf("find Hermes config: %s", detail)
		}
		return "", fmt.Errorf("find Hermes config: %w", err)
	}
	lines := strings.Split(strings.TrimSpace(stdout.String()), "\n")
	path := strings.TrimSpace(lines[len(lines)-1])
	if path == "" {
		return "", errors.New("find Hermes config: `hermes config path` printed no path")
	}
	return path, nil
}

// Setup writes the Dari provider, offering the router's models, into the
// config at path and makes it the main model.
func Setup(path, baseURL, key string, models agents.Models) error {
	doc, err := readConfig(path)
	if err != nil {
		return err
	}
	root := doc.Content[0]
	model := mapping(root, "model")
	if scalar(model, "provider") != providerID {
		saved := savedSetup{Model: map[string]any{}}
		for _, name := range replacedKeys {
			if value := lookup(model, name); value != nil {
				var decoded any
				if err := value.Decode(&decoded); err != nil {
					return fmt.Errorf("read Hermes model settings: %w", err)
				}
				saved.Model[name] = decoded
			}
		}
		if err := writeSaved(filepath.Dir(path), saved); err != nil {
			return err
		}
	}
	for _, name := range replacedKeys {
		remove(model, name)
	}
	if err := set(model, "provider", providerID); err != nil {
		return err
	}
	if err := set(model, "default", models.Default()); err != nil {
		return err
	}
	if err := set(mapping(root, "providers"), providerID, newProviderEntry(baseURL, key, models)); err != nil {
		return err
	}
	return writeConfig(path, doc)
}

// providerEntry is the Dari entry under providers, in the order Hermes's own
// writer uses.
type providerEntry struct {
	Name          string `yaml:"name"`
	BaseURL       string `yaml:"base_url"`
	APIKey        string `yaml:"api_key"`
	Transport     string `yaml:"transport"`
	DefaultModel  string `yaml:"default_model"`
	ContextLength int    `yaml:"context_length"`
	// Hermes sends its session id in this header, which the router groups
	// into one conversation.
	SessionAffinityHeader string `yaml:"session_affinity_header"`
	// Hermes names itself on every request, so a gateway serves the models
	// it lists for Hermes.
	ExtraHeaders map[string]string `yaml:"extra_headers"`
	Models       yaml.Node         `yaml:"models"`
}

func newProviderEntry(baseURL, key string, models agents.Models) providerEntry {
	// Keep the menu's order, default first, in Hermes's model picker.
	offered := yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for _, id := range models.Menu() {
		offered.Content = append(offered.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: id},
			&yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Style: yaml.FlowStyle})
	}
	return providerEntry{
		Name:                  "Dari",
		BaseURL:               baseURL + "/v1",
		APIKey:                key,
		Transport:             "chat_completions",
		DefaultModel:          models.Default(),
		ContextLength:         1_000_000,
		SessionAffinityHeader: "x-session-affinity",
		ExtraHeaders:          map[string]string{agents.ClientHarnessHeader: "hermes"},
		Models:                offered,
	}
}

// RemoveSetup removes the Dari provider, restores the main-model settings
// Setup replaced, and reports whether Dari was set up.
func RemoveSetup(path string) (bool, error) {
	doc, err := readConfig(path)
	if err != nil {
		return false, err
	}
	root := doc.Content[0]
	providers := lookup(root, "providers")
	if lookup(providers, providerID) == nil {
		return false, nil
	}
	remove(providers, providerID)
	if len(providers.Content) == 0 {
		remove(root, "providers")
	}
	if model := lookup(root, "model"); model != nil && scalar(model, "provider") == providerID {
		saved, err := readSaved(filepath.Dir(path))
		if err != nil {
			return false, err
		}
		for _, name := range replacedKeys {
			remove(model, name)
		}
		for _, name := range replacedKeys {
			if value, ok := saved.Model[name]; ok {
				if err := set(model, name, value); err != nil {
					return false, err
				}
			}
		}
		if len(model.Content) == 0 {
			remove(root, "model")
		}
	}
	if len(root.Content) == 0 {
		if err := os.Remove(path); err != nil {
			return false, fmt.Errorf("remove Hermes config: %w", err)
		}
	} else if err := writeConfig(path, doc); err != nil {
		return false, err
	}
	if err := os.Remove(filepath.Join(filepath.Dir(path), setupFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("remove Hermes setup record: %w", err)
	}
	return true, nil
}

func readConfig(path string) (*yaml.Node, error) {
	body, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read Hermes config: %w", err)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("read Hermes config %s: %w", path, err)
	}
	if doc.Kind == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("Hermes config %s is not a YAML mapping", path)
	}
	return &doc, nil
}

func writeConfig(path string, doc *yaml.Node) error {
	var body bytes.Buffer
	encoder := yaml.NewEncoder(&body)
	encoder.SetIndent(2)
	if err := encoder.Encode(doc); err != nil {
		return fmt.Errorf("encode Hermes config: %w", err)
	}
	if err := encoder.Close(); err != nil {
		return fmt.Errorf("encode Hermes config: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create Hermes config directory: %w", err)
	}
	temp := path + ".dari-tmp"
	if err := os.WriteFile(temp, body.Bytes(), 0o600); err != nil {
		return fmt.Errorf("write Hermes config: %w", err)
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return fmt.Errorf("write Hermes config: %w", err)
	}
	return nil
}

// lookup returns the value under key in a mapping node, or nil.
func lookup(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			return node.Content[i+1]
		}
	}
	return nil
}

func scalar(node *yaml.Node, key string) string {
	if value := lookup(node, key); value != nil && value.Kind == yaml.ScalarNode {
		return value.Value
	}
	return ""
}

// mapping returns the mapping under key, creating it, or replacing a value
// that is not a mapping. A bare `model: <id>` keeps its id as the default.
func mapping(node *yaml.Node, key string) *yaml.Node {
	value := lookup(node, key)
	if value != nil && value.Kind == yaml.MappingNode {
		return value
	}
	created := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	if value != nil && value.Kind == yaml.ScalarNode && value.Value != "" && key == "model" {
		created.Content = []*yaml.Node{
			{Kind: yaml.ScalarNode, Tag: "!!str", Value: "default"},
			{Kind: yaml.ScalarNode, Tag: "!!str", Value: value.Value},
		}
	}
	if value != nil {
		*value = *created
		return value
	}
	node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, created)
	return created
}

func set(node *yaml.Node, key string, value any) error {
	var encoded yaml.Node
	if err := encoded.Encode(value); err != nil {
		return fmt.Errorf("encode Hermes config %s: %w", key, err)
	}
	if existing := lookup(node, key); existing != nil {
		*existing = encoded
		return nil
	}
	node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, &encoded)
	return nil
}

func remove(node *yaml.Node, key string) {
	if node == nil || node.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			node.Content = append(node.Content[:i], node.Content[i+2:]...)
			return
		}
	}
}

func readSaved(dir string) (savedSetup, error) {
	var saved savedSetup
	body, err := os.ReadFile(filepath.Join(dir, setupFile))
	if errors.Is(err, os.ErrNotExist) {
		return saved, nil
	}
	if err != nil {
		return saved, fmt.Errorf("read Hermes setup record: %w", err)
	}
	if err := json.Unmarshal(body, &saved); err != nil {
		return saved, fmt.Errorf("read Hermes setup record: %w", err)
	}
	return saved, nil
}

func writeSaved(dir string, saved savedSetup) error {
	body, err := json.Marshal(saved)
	if err != nil {
		return fmt.Errorf("encode Hermes setup record: %w", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create Hermes config directory: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, setupFile), body, 0o600); err != nil {
		return fmt.Errorf("write Hermes setup record: %w", err)
	}
	return nil
}

// IsSetUp reports whether Dari is set up in the Hermes config at path.
func IsSetUp(path string) bool {
	_, err := os.Stat(filepath.Join(filepath.Dir(path), setupFile))
	return err == nil
}
