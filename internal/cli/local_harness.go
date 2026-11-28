package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mupt-ai/dari/internal/cli/agents"
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
	agent, ok := agentNamed(l.name)
	if !ok || agent.Local == nil {
		return cmd, errors.New("unsupported local harness")
	}
	output := max(1, min(8192, window/4))
	return agent.Local(ctx, cmd, agents.Local{
		Model:    l.localModel,
		Endpoint: base + "/v1",
		Window:   window,
		Output:   output,
		Dir:      s.dir,
		Config:   s.config,
		Bridge: func() (string, string, error) {
			return s.bridge(ctx, base, l.localModel, window, output, stderr)
		},
	})
}
