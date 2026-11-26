package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/codex"
	"github.com/mupt-ai/dari/internal/cli/agents/pi"
	"github.com/mupt-ai/dari/internal/selfupdate"
)

func bridgePath(version string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "dari", "inference", "v"+strings.TrimPrefix(version, "v"), "bin", "dari-gateway"), nil
}
func installInferenceBridge(ctx context.Context, version string) error {
	if !selfupdate.IsReleaseVersion(version) || os.Getenv("DARI_INFERENCE_SOURCE") != "" {
		return nil
	}
	p, err := bridgePath(version)
	if err != nil {
		return err
	}
	if _, err = exec.LookPath(p); err == nil {
		return nil
	}
	_, err = selfupdate.Install(ctx, version, selfupdate.ReleasesURL+"/tags/v"+strings.TrimPrefix(version, "v"), "dari-gateway", p)
	return err
}

// Translate Responses and Messages using the existing gateway, never the user's
// running gateway: no saved routes, subscriptions, provider keys or proxy env.
func (s *localSession) bridge(ctx context.Context, base, model string, window, output int, stderr io.Writer) (string, string, error) {
	binary, err := bridgePath(cliVersion)
	if err != nil {
		return "", "", err
	}
	if override := os.Getenv("DARI_INFERENCE_GATEWAY"); override != "" {
		binary = override
	}
	if _, err = exec.LookPath(binary); err != nil {
		return "", "", fmt.Errorf("local protocol bridge missing; run dari pull %s", model)
	}
	route := map[string]any{"models": []any{map[string]any{"id": "local/" + model, "thinking": []string{"off"}}}, "subscriptions": false, "retries": 0}
	endpoint := map[string]any{"baseUrl": base + "/v1", "contextWindow": window, "maxOutputTokens": output}
	config, err := s.config("gateway.json", map[string]any{
		"routers": map[string]any{"default": route}, "providers": map[string]any{"local": endpoint},
	})
	if err != nil {
		return "", "", err
	}
	var token [32]byte
	rand.Read(token[:])
	key := hex.EncodeToString(token[:])
	cmd := exec.CommandContext(ctx, binary)
	cmd.Dir = s.dir
	cmd.Env = []string{"HOME=" + s.dir, "PORT=0", "DARI_GATEWAY_HOST=127.0.0.1", "DARI_GATEWAY_CONFIG=" + config, "DARI_GATEWAY_DB=:memory:", "DARI_GATEWAY_KEYS=" + key}
	url, err := s.start(ctx, cmd, stderr)
	return url, key, err
}

func (s *localSession) harness(ctx context.Context, path string, l agentLaunch, base string, window int, stderr io.Writer) (agents.Command, error) {
	cmd := agents.Command{Path: path, Args: l.args, Env: os.Environ()}
	model := l.localModel
	endpoint := base + "/v1"
	output := max(1, min(8192, window/4))
	env := map[string]string{}
	switch l.name {
	case "pi":
		return pi.LocalCommand(path, l.args, model, endpoint, window)
	case "hermes":
		if window < 64000 {
			return cmd, fmt.Errorf("Hermes needs at least 64000 context tokens; restart the engine with dari run %s --context-window 64000", model)
		}
		cfg := map[string]any{"model": map[string]any{"default": model, "provider": "custom", "base_url": endpoint, "context_length": window}}
		if _, err := s.config("config.yaml", cfg); err != nil {
			return cmd, err
		}
		env = map[string]string{"HERMES_HOME": s.dir, "CUSTOM_BASE_URL": endpoint, "OPENAI_API_KEY": "local"}
		args := l.args
		if len(args) > 0 && args[0] == "chat" {
			args = args[1:]
		}
		cmd.Args = append([]string{"chat", "--provider", "custom", "--model", model}, args...)
	case "openclaw":
		workspace, err := os.Getwd()
		if err != nil {
			return cmd, err
		}
		entry := map[string]any{"id": model, "name": model, "contextWindow": window, "maxTokens": output}
		provider := map[string]any{"api": "openai-completions", "baseUrl": endpoint, "apiKey": "local", "models": []any{entry}}
		defaults := map[string]any{"workspace": workspace, "skipBootstrap": true, "model": map[string]string{"primary": "dari/" + model}}
		cfg := map[string]any{
			"models": map[string]any{"providers": map[string]any{"dari": provider}},
			"agents": map[string]any{"defaults": defaults},
		}
		p, err := s.config("openclaw.json", cfg)
		if err != nil {
			return cmd, err
		}
		env = map[string]string{"OPENCLAW_CONFIG_PATH": p, "OPENCLAW_STATE_DIR": s.dir}
		sub := "tui"
		args := l.args
		if len(args) > 0 && (args[0] == "agent" || args[0] == "tui") {
			sub, args = args[0], args[1:]
		}
		cmd.Args = append([]string{sub, "--local"}, args...)
	case "opencode":
		ref := "dari-local/" + model
		entry := map[string]any{"name": model, "limit": map[string]int{"context": window, "output": output}}
		provider := map[string]any{
			"npm":     "@ai-sdk/openai-compatible",
			"options": map[string]string{"baseURL": endpoint, "apiKey": "local"},
			"models":  map[string]any{model: entry},
		}
		cfg := map[string]any{
			"model": ref, "small_model": ref, "enabled_providers": []string{"dari-local"},
			"provider": map[string]any{"dari-local": provider},
		}
		b, err := json.Marshal(cfg)
		if err != nil {
			return cmd, err
		}
		env = map[string]string{"OPENCODE_CONFIG_CONTENT": string(b), "OPENCODE_DISABLE_AUTOUPDATE": "1"}
		cmd.Args = agents.InsertBeforeDoubleDash(cmd.Args, []string{"--standalone"})
	case "codex", "claude", "muse":
		url, key, err := s.bridge(ctx, base, model, window, output, stderr)
		if err != nil {
			return cmd, err
		}
		models := agents.Models{Enabled: []string{"local/" + model}, ContextWindow: window}
		id := models.Default()
		switch l.name {
		case "codex":
			codex.Configure(&cmd, url, models)
			if err := codex.PrepareCatalog(ctx, &cmd, key, url, models); err != nil {
				return cmd, err
			}
			cmd.Args = agents.InsertBeforeDoubleDash(cmd.Args, []string{"-c", `web_search="disabled"`, "-c", "model_context_window=" + strconv.Itoa(window)})
			env[agents.RoutingAPIKeyEnv] = key
		case "claude":
			cmd.Args = agents.InsertBeforeDoubleDash(cmd.Args, []string{"--model", id})
			env = map[string]string{
				"ANTHROPIC_BASE_URL":                       url,
				"ANTHROPIC_AUTH_TOKEN":                     key,
				"ANTHROPIC_API_KEY":                        "",
				"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
				"CLAUDE_CODE_MAX_CONTEXT_TOKENS":           strconv.Itoa(window),
				"CLAUDE_CODE_MAX_OUTPUT_TOKENS":            strconv.Itoa(output),
				"ANTHROPIC_CUSTOM_HEADERS":                 "",
				"CLAUDE_CODE_AUTO_MODE_MODEL":              id,
				"CLAUDE_CODE_SUBAGENT_MODEL":               id,
				"ANTHROPIC_DEFAULT_HAIKU_MODEL":            id,
				"ANTHROPIC_DEFAULT_SONNET_MODEL":           id,
				"ANTHROPIC_DEFAULT_FABLE_MODEL":            id,
				"ANTHROPIC_DEFAULT_OPUS_MODEL":             id,
				"CLAUDE_CODE_USE_BEDROCK":                  "0",
				"CLAUDE_CODE_USE_VERTEX":                   "0",
				"CLAUDE_CODE_USE_FOUNDRY":                  "0",
			}
			// Saved Claude settings override inherited env. A launch-scoped
			// settings file keeps the chosen endpoint and credentials together.
			settings, err := s.config("claude.json", map[string]any{"env": env, "modelPicker": map[string]any{"options": []any{map[string]string{"model": id, "label": model}}, "replaceBuiltInOptions": true}})
			if err != nil {
				return cmd, err
			}
			cmd.Args = agents.InsertBeforeDoubleDash(cmd.Args, []string{"--settings", settings})
		case "muse":
			cmd.Args = agents.InsertBeforeDoubleDash(cmd.Args, []string{"--model", id, "-c", "endpoint_transport.base_url=" + strconv.Quote(url+"/v1"), "-c", `endpoint_transport.auth="bearer"`})
			env = map[string]string{"META_API_KEY": key, "MUSE_NO_AUTO_UPDATE": "1"}
		}
	default:
		return cmd, errors.New("unsupported local harness")
	}
	cmd.Env = agents.WithEnvironment(cmd.Env, env)
	return cmd, nil
}
