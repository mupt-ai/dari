package cli

import (
	"github.com/mupt-ai/dari-cli/internal/cli/agents"

	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var routingRequestUUID = regexp.MustCompile(`^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

func newRouterRequestCostsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "request-costs <request_uuid>...",
		Short: "Show per-request model reference costs using DARI_ROUTING_API_KEY",
		Long:  "Read pricing for requests made with the same DARI_ROUTING_API_KEY. Model reference cost is not a subscription cash charge. No inference is performed.",
		Args: func(cmd *cobra.Command, args []string) error {
			if err := cobra.RangeArgs(1, 1000)(cmd, args); err != nil {
				return err
			}
			for _, id := range args {
				if !routingRequestUUID.MatchString(id) {
					return fmt.Errorf("expected request UUID, got %q", id)
				}
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			gateway, err := currentGateway()
			if err != nil {
				return err
			}
			if gateway != nil {
				return fmt.Errorf("request costs are only available on the hosted Dari API; they are not supported with a gateway")
			}
			key := strings.TrimSpace(os.Getenv(agents.RoutingAPIKeyEnv))
			if key == "" {
				return fmt.Errorf("DARI_ROUTING_API_KEY is required; use the key that made these requests")
			}
			data, err := fetchRoutingRequestCosts(cmd.Context(), routingBaseURL, key, args)
			if err != nil {
				return err
			}
			return json.NewEncoder(cmd.OutOrStdout()).Encode(data)
		},
	}
	return cmd
}

func fetchRoutingRequestCosts(ctx context.Context, baseURL, key string, ids []string) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, err := json.Marshal(map[string]any{"request_ids": ids})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v1/request-costs", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch request costs: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch request costs: HTTP %d", resp.StatusCode)
	}
	const maxBytes = 1 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxBytes || !json.Valid(data) {
		return nil, fmt.Errorf("invalid request-cost response")
	}
	return json.RawMessage(data), nil
}
