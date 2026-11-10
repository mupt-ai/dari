package cli

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari-cli/internal/api"
	"github.com/mupt-ai/dari-cli/internal/auth"
	"github.com/mupt-ai/dari-cli/internal/cli/agents"
	"github.com/mupt-ai/dari-cli/internal/gateway"
)

// A Dari Gateway serves the routing and subscription paths of the hosted API.
// The agent launchers and subscription commands use one, and make no hosted
// control-plane calls, when DARI_GATEWAY_URL is set or `dari gateway setup`
// chose a local or self-hosted gateway.
const (
	gatewayURLEnv = agents.GatewayURLEnv
	gatewayKeyEnv = "DARI_GATEWAY_KEY"
)

// A gateway has no saved credentials: it reads each model provider's API key
// from the standard variable in its own environment.
var errGatewayProviderKeys = fmt.Errorf("a gateway reads provider keys from its own environment, such as " +
	"ANTHROPIC_API_KEY, OPENAI_API_KEY, META_API_KEY, OPENROUTER_API_KEY, or AI_GATEWAY_API_KEY for Vercel AI Gateway; " +
	"for the local gateway, export them and run `dari gateway restart`, or run `dari gateway setup` to save keys on the hosted Dari API")

type gatewayConfig struct {
	url string
	key string
	// local is the gateway this CLI runs on this machine.
	local    bool
	settings gateway.Settings
}

// gatewayFromEnv returns nil when DARI_GATEWAY_URL is unset.
func gatewayFromEnv() (*gatewayConfig, error) {
	raw := strings.TrimSpace(os.Getenv(gatewayURLEnv))
	if raw == "" {
		return nil, nil
	}
	base, err := normalizeGatewayURL(raw)
	if err != nil {
		return nil, fmt.Errorf("%s must be an http or https URL", gatewayURLEnv)
	}
	key := strings.TrimSpace(os.Getenv(gatewayKeyEnv))
	if key == "" {
		return nil, fmt.Errorf("%s is required when %s is set", gatewayKeyEnv, gatewayURLEnv)
	}
	return &gatewayConfig{url: base, key: key}, nil
}

func normalizeGatewayURL(raw string) (string, error) {
	base := strings.TrimRight(strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(raw), "/"), "/v1"), "/")
	parsed, err := url.Parse(base)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("%q is not an http or https URL", raw)
	}
	return base, nil
}

// currentGateway returns the gateway the CLI routes through: DARI_GATEWAY_URL,
// else the one `dari gateway setup` saved. nil means the hosted Dari API.
func currentGateway() (*gatewayConfig, error) {
	if gw, err := gatewayFromEnv(); gw != nil || err != nil {
		return gw, err
	}
	settings, ok, err := gateway.Load()
	if err != nil || !ok {
		return nil, err
	}
	switch settings.Mode {
	case gateway.ModeLocal:
		return &gatewayConfig{url: gateway.LocalURL(), key: settings.LocalKey, local: true, settings: settings}, nil
	case gateway.ModeSelfHosted:
		return &gatewayConfig{url: settings.URL, key: settings.Key, settings: settings}, nil
	}
	return nil, nil
}

// ensure starts a local gateway that is not running; other gateways run
// elsewhere.
func (gw *gatewayConfig) ensure(ctx context.Context, stderr io.Writer) error {
	if !gw.local {
		return nil
	}
	return gateway.EnsureRunning(ctx, gw.settings, cliVersion, func(line string) { agentStep(stderr, line) })
}

// subscriptionClient authenticates subscription commands with the gateway key
// in gateway mode, and otherwise with the current organization's key.
func subscriptionClient(ctx context.Context, gf *globalFlags, stderr io.Writer) (*api.Client, error) {
	gw, err := currentGateway()
	if err != nil {
		return nil, err
	}
	if gw != nil {
		if err := gw.ensure(ctx, stderr); err != nil {
			return nil, err
		}
		return api.New(gw.url).WithBearer(gw.key), nil
	}
	apiURL, err := gf.resolveAPIURL()
	if err != nil {
		return nil, err
	}
	return auth.OrgKeyClient(apiURL)
}

// subscriptionRequest is orgKeyRequest for the subscription commands, which
// talk to the gateway in gateway mode.
func subscriptionRequest(cmd *cobra.Command, gf *globalFlags, method, path string, body, out any) error {
	client, err := subscriptionClient(cmd.Context(), gf, cmd.ErrOrStderr())
	if err != nil {
		return err
	}
	return client.Do(cmd.Context(), method, path, body, out)
}
