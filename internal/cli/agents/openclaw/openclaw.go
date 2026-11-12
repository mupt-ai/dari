// Package openclaw sets OpenClaw up to route through Dari. Every OpenClaw
// session, channel, and scheduled task runs in one long-lived gateway that
// reads OpenClaw's own config, so Dari is written there rather than into a
// single launch. The writes go through `openclaw config`, which validates
// them, keeps the config's other settings, and hot-reloads a running gateway.
package openclaw

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

	"github.com/mupt-ai/dari/internal/cli/agents"
)

const (
	providerID = "dari"
	// setupFile, beside OpenClaw's config, keeps the default model Dari
	// replaced so removing setup can restore it.
	setupFile = "dari-setup.json"
)

type savedSetup struct {
	Primary string `json:"primary"`
}

// Setup adds Dari as the "dari" provider offering the router's models and
// makes the default model Dari's, keeping any fallbacks.
func Setup(ctx context.Context, executable, baseURL, key string, models agents.Models) error {
	config, err := configPath(ctx, executable)
	if err != nil {
		return err
	}
	primary, err := currentPrimary(ctx, executable)
	if err != nil {
		return err
	}
	if !isDariModel(primary) {
		if err := writeSaved(filepath.Dir(config), savedSetup{Primary: primary}); err != nil {
			return err
		}
	}
	patch := map[string]any{
		"models": map[string]any{"providers": map[string]any{providerID: provider(baseURL, key, models)}},
		"agents": map[string]any{"defaults": map[string]any{"model": map[string]any{"primary": providerID + "/" + models.Default()}}},
	}
	return applyPatch(ctx, executable, patch, "--replace-path", "models.providers."+providerID)
}

// RemoveSetup removes the Dari provider, restores the default model Setup
// replaced, and reports whether Dari was set up.
func RemoveSetup(ctx context.Context, executable string) (bool, error) {
	config, err := configPath(ctx, executable)
	if err != nil {
		return false, err
	}
	_, found, err := get(ctx, executable, "models.providers."+providerID)
	if err != nil || !found {
		return false, err
	}
	saved, err := readSaved(filepath.Dir(config))
	if err != nil {
		return false, err
	}
	patch := map[string]any{"models": map[string]any{"providers": map[string]any{providerID: nil}}}
	primary, err := currentPrimary(ctx, executable)
	if err != nil {
		return false, err
	}
	if isDariModel(primary) {
		var restored any
		if saved.Primary != "" {
			restored = saved.Primary
		}
		patch["agents"] = map[string]any{"defaults": map[string]any{"model": map[string]any{"primary": restored}}}
	}
	if err := applyPatch(ctx, executable, patch); err != nil {
		return false, err
	}
	if err := os.Remove(filepath.Join(filepath.Dir(config), setupFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("remove OpenClaw setup record: %w", err)
	}
	return true, nil
}

// provider is the Dari entry under models.providers. Prompt cache keys and
// session affinity headers carry OpenClaw's session to the router, which
// groups its turns into one conversation. OpenClaw names itself on every
// request, so a gateway serves the models it lists for OpenClaw.
func provider(baseURL, key string, models agents.Models) map[string]any {
	offered := make([]map[string]any, 0, len(models.Menu()))
	for _, model := range models.Menu() {
		name := strings.TrimPrefix(model, agents.ExplicitModelPrefix)
		if model == agents.RoutingModel {
			name = "Dari Router"
		}
		reasoning := model != agents.RoutingModel
		offered = append(offered, map[string]any{
			"id":            model,
			"name":          name,
			"reasoning":     reasoning,
			"input":         []string{"text", "image"},
			"contextWindow": 1_000_000,
			"maxTokens":     128_000,
			// OpenClaw sends a chosen thinking level only to a model that
			// claims reasoning_effort support; the router picks it for routing.
			"compat": map[string]bool{
				"supportsPromptCacheKey":     true,
				"sendSessionAffinityHeaders": true,
				"supportsReasoningEffort":    reasoning,
			},
		})
	}
	return map[string]any{
		"baseUrl": baseURL + "/v1",
		"apiKey":  key,
		"api":     "openai-completions",
		"headers": map[string]string{agents.ClientHarnessHeader: "openclaw"},
		"models":  offered,
	}
}

func isDariModel(ref string) bool {
	return strings.HasPrefix(ref, providerID+"/")
}

// currentPrimary is the configured default model, or "" when none is set.
// OpenClaw accepts the model as a bare ref or as {primary, fallbacks}.
func currentPrimary(ctx context.Context, executable string) (string, error) {
	value, found, err := get(ctx, executable, "agents.defaults.model")
	if err != nil || !found {
		return "", err
	}
	var ref string
	if json.Unmarshal(value, &ref) == nil {
		return ref, nil
	}
	var model struct {
		Primary string `json:"primary"`
	}
	if err := json.Unmarshal(value, &model); err != nil {
		return "", fmt.Errorf("read OpenClaw default model: %w", err)
	}
	return model.Primary, nil
}

// get reads one config path as JSON; an unset path is not found.
func get(ctx context.Context, executable, path string) (json.RawMessage, bool, error) {
	stdout, stderr, err := run(ctx, executable, nil, "config", "get", path, "--json")
	if err == nil {
		return json.RawMessage(stdout), true, nil
	}
	var failure struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(stdout, &failure) == nil && strings.Contains(failure.Error.Message, "valid but unset") {
		return nil, false, nil
	}
	return nil, false, commandError("read OpenClaw config", append(stdout, stderr...), err)
}

func configPath(ctx context.Context, executable string) (string, error) {
	stdout, stderr, err := run(ctx, executable, nil, "config", "file")
	if err != nil {
		return "", commandError("find OpenClaw config", append(stdout, stderr...), err)
	}
	lines := strings.Split(strings.TrimSpace(string(stdout)), "\n")
	path := strings.TrimSpace(lines[len(lines)-1])
	if path == "" {
		return "", errors.New("find OpenClaw config: `openclaw config file` printed no path")
	}
	return path, nil
}

func applyPatch(ctx context.Context, executable string, patch map[string]any, flags ...string) error {
	body, err := json.Marshal(patch)
	if err != nil {
		return fmt.Errorf("encode OpenClaw config: %w", err)
	}
	args := append([]string{"config", "patch", "--stdin"}, flags...)
	stdout, stderr, err := run(ctx, executable, body, args...)
	if err != nil {
		return commandError("write OpenClaw config", append(stdout, stderr...), err)
	}
	return nil
}

func run(ctx context.Context, executable string, stdin []byte, args ...string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Stdin = bytes.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

func commandError(action string, output []byte, err error) error {
	if detail := strings.TrimSpace(string(output)); detail != "" {
		return fmt.Errorf("%s: %s", action, detail)
	}
	return fmt.Errorf("%s: %w", action, err)
}

func readSaved(dir string) (savedSetup, error) {
	var saved savedSetup
	body, err := os.ReadFile(filepath.Join(dir, setupFile))
	if errors.Is(err, os.ErrNotExist) {
		return saved, nil
	}
	if err != nil {
		return saved, fmt.Errorf("read OpenClaw setup record: %w", err)
	}
	if err := json.Unmarshal(body, &saved); err != nil {
		return saved, fmt.Errorf("read OpenClaw setup record: %w", err)
	}
	return saved, nil
}

func writeSaved(dir string, saved savedSetup) error {
	body, err := json.Marshal(saved)
	if err != nil {
		return fmt.Errorf("encode OpenClaw setup record: %w", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create OpenClaw config directory: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, setupFile), body, 0o600); err != nil {
		return fmt.Errorf("write OpenClaw setup record: %w", err)
	}
	return nil
}

// IsSetUp reports whether Dari is set up in OpenClaw's config.
func IsSetUp(ctx context.Context, executable string) bool {
	config, err := configPath(ctx, executable)
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(filepath.Dir(config), setupFile))
	return err == nil
}
