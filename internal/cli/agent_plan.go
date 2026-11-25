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
	Credentials []agentCredential `json:"credentials"`
	// The user's plans on their own gateways, this computer's among them.
	LocalSubscriptions []localSubscription `json:"local_subscriptions"`
	AutoroutingAllowed *bool               `json:"autorouting_allowed"`
}

// errNoProviderCredentials is a gateway router with no subscription or API
// key that can serve any of its models.
var errNoProviderCredentials = errors.New("no connected account or API key can serve this gateway's models; " +
	"connect one with `dari accounts` or `dari accounts subscription connect`")

// errRouterKeyRefused is a router that did not accept the key it was sent.
var errRouterKeyRefused = errors.New("the key was not accepted")

// routerModels builds a launch's model menu from the router's /v1/models at
// baseURL, the same list in hosted and gateway mode: dari/routing when the
// router may autoroute, then every enabled model. A gateway lists the models
// it serves agent; "" names none.
func routerModels(ctx context.Context, baseURL, key, agent string) (agents.Models, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/models", nil)
	if err != nil {
		return agents.Models{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	// The gateway lists what it serves this agent: the agent's own models
	// when it has some, and a subscription that serves only its own agent
	// (Claude Code, Muse Code) only for that agent.
	if client := agentSetups[agent].codingAgent; client != "" {
		req.Header.Set(agents.ClientHarnessHeader, client)
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
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return agents.Models{}, errRouterKeyRefused
		}
		return agents.Models{}, fmt.Errorf("list router models: HTTP %d", resp.StatusCode)
	}
	var catalog struct {
		Models []struct {
			Slug          string `json:"slug"`
			ContextWindow int    `json:"context_window"`
		} `json:"models"`
		RemoteCompaction string `json:"remote_compaction"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&catalog); err != nil {
		return agents.Models{}, fmt.Errorf("decode router models: %w", err)
	}
	models := agents.Models{RemoteCompaction: catalog.RemoteCompaction == "v2"}
	for _, model := range catalog.Models {
		if model.Slug == agents.RoutingModel {
			models.Routing = true
		} else if id, ok := strings.CutPrefix(model.Slug, agents.ExplicitModelPrefix); ok {
			models.Enabled = append(models.Enabled, id)
		}
	}
	for _, model := range catalog.Models {
		if model.Slug == models.Stable() {
			models.ContextWindow = model.ContextWindow
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
	details := []string{"$20/month. Dari picks the model for each request."}
	switch {
	case opened:
		details = append(details, "Opened in your browser. If it didn't open:")
	case usageURL != "":
		details = append(details, "Subscribe at:")
	default:
		details = append(details, "Subscribe on the Usage page at app.dari.dev.")
	}
	if usageURL != "" {
		details = append(details, agentURLLines(usageURL, 0)...)
	}
	for {
		choice, err := runAgentChoiceTUI(stdin, stderr, "Get Auto-Routing", details, []agentChoiceOption{
			{label: "I've Subscribed, Check Again"},
			{label: "Not Now"},
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
