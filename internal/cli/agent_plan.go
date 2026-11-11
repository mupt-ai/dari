package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/cli/agents"
)

type agentSubscriptionStatus struct {
	Credentials        []agentCredential `json:"credentials"`
	AutoroutingAllowed *bool             `json:"autorouting_allowed"`
}

// routerModels builds a launch's model menu from the router's /v1/models at
// baseURL, the same list in hosted and gateway mode: dari/routing when the
// router may autoroute, then every enabled model.
// clientHarnessHeader names the agent a model list is for, so the router
// lists the models that agent's own requests can be served.
const clientHarnessHeader = "x-dari-client-harness"

// agentClientHarness is the client each agent's requests identify as.
var agentClientHarness = map[string]string{"claude": "claude_code", "muse": "muse_code"}

// errNoProviderCredentials is a gateway router with no subscription or API
// key that can serve any of its models.
var errNoProviderCredentials = errors.New("no connected account or API key can serve this gateway's models; " +
	"connect one with `dari accounts` or `dari credentials subscription connect`")

func routerModels(ctx context.Context, baseURL, key, agent string) (agents.Models, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/models", nil)
	if err != nil {
		return agents.Models{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	// A subscription that serves only its own agent (Claude Code, Muse Code)
	// counts toward the list only when the list is for that agent.
	if client := agentClientHarness[agent]; client != "" {
		req.Header.Set(clientHarnessHeader, client)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return agents.Models{}, fmt.Errorf("list router models: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var failure struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&failure)
		if failure.Error.Code == "provider_credentials_missing" {
			return agents.Models{}, errNoProviderCredentials
		}
		return agents.Models{}, fmt.Errorf("list router models: HTTP %d", resp.StatusCode)
	}
	var catalog struct {
		Models []struct {
			Slug string `json:"slug"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&catalog); err != nil {
		return agents.Models{}, fmt.Errorf("decode router models: %w", err)
	}
	models := agents.Models{}
	for _, model := range catalog.Models {
		if model.Slug == agents.RoutingModel {
			models.Routing = true
		} else if id, ok := strings.CutPrefix(model.Slug, agents.ExplicitModelPrefix); ok {
			models.Enabled = append(models.Enabled, id)
		}
	}
	return models, nil
}

// autoroutingAllowed reports whether the organization has the Autorouting
// plan. Older servers do not report it; they route as before.
func autoroutingAllowed(ctx context.Context, client *api.Client) (bool, error) {
	var status agentSubscriptionStatus
	if err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials", nil, &status); err != nil {
		return false, api.HumanError(err)
	}
	return status.AutoroutingAllowed == nil || *status.AutoroutingAllowed, nil
}

// agentWebAppURL is a page of the web app, such as /usage where the
// Autorouting plan is bought, or "" when the server does not say where the
// web app is.
func agentWebAppURL(ctx context.Context, client *api.Client, page string) string {
	var config struct {
		WebAppURL string `json:"web_app_url"`
	}
	if err := api.New(client.BaseURL).Do(ctx, http.MethodGet, "/v1/auth/config", nil, &config); err != nil || config.WebAppURL == "" {
		return ""
	}
	return strings.TrimRight(config.WebAppURL, "/") + page
}

// getAutorouting opens the Usage page and waits while the user subscribes,
// rechecking the plan until it is active or they skip. It reports whether
// the plan is active.
func getAutorouting(ctx context.Context, client *api.Client, stdin io.Reader, stderr io.Writer) (bool, error) {
	usageURL := agentWebAppURL(ctx, client, "/usage")
	opened := usageURL != "" && openAgentBrowser(usageURL)
	details := []string{"  " + ansiGray + "$20/month. Dari picks the best of your router's models for each request." + ansiReset}
	switch {
	case opened:
		details = append(details, "  "+ansiGray+"Opened the Usage page in your browser. If it didn't open, visit:"+ansiReset)
	case usageURL != "":
		details = append(details, "  "+ansiGray+"Subscribe on the Usage page:"+ansiReset)
	default:
		details = append(details, "  "+ansiGray+"Subscribe on the Usage page of the Dari web app."+ansiReset)
	}
	if usageURL != "" {
		details = append(details, agentURLLines(usageURL, 0)...)
	}
	details = append(details, "")
	for {
		choice, err := runAgentChoiceTUI(stdin, stderr, "Get auto-routing", details, []agentChoiceOption{
			{label: "I've subscribed, check again"},
			{label: "Not now"},
		})
		if err != nil || choice == 1 {
			return false, err
		}
		active, err := autoroutingAllowed(ctx, client)
		if err != nil {
			return false, err
		}
		if active {
			agentStep(stderr, "Auto-routing is active")
			return true, nil
		}
		details[len(details)-1] = "  " + ansiCoral + "Auto-routing isn't active for this organization yet." + ansiReset
	}
}
