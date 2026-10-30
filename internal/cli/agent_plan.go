package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/mupt-ai/dari-cli/internal/api"
	"github.com/mupt-ai/dari-cli/internal/auth"
	"github.com/mupt-ai/dari-cli/internal/cli/agents"
)

type agentSubscriptionStatus struct {
	Credentials        []agentCredential `json:"credentials"`
	AutoroutingAllowed *bool             `json:"autorouting_allowed"`
}

// agentModels builds the model menu for a launch: every model enabled on the
// router, plus dari/routing when the organization has the Autorouting plan.
// Without the plan the launch starts on the router's first model and says so.
func agentModels(ctx context.Context, agent string, access agentRoutingAccess, routerID string, stderr io.Writer) (agents.Models, error) {
	client, err := auth.OrgKeyClient(access.apiURL)
	if err != nil {
		return agents.Models{}, err
	}
	return routerModels(ctx, client, agent, routerID, stderr)
}

func routerModels(ctx context.Context, client *api.Client, agent, routerID string, stderr io.Writer) (agents.Models, error) {
	routers, err := listAgentRouters(ctx, client)
	if err != nil {
		return agents.Models{}, err
	}
	router, ok := findAgentRouter(routers, func(router agentRouter) bool {
		if routerID == "default" {
			return router.IsDefault
		}
		return router.ID == routerID
	})
	if !ok {
		return agents.Models{Routing: true}, nil
	}
	routing, err := autoroutingAllowed(ctx, client)
	if err != nil {
		return agents.Models{}, err
	}
	models := agents.Models{Routing: routing, Enabled: router.EnabledModels}
	if !models.Routing && len(models.Enabled) > 0 {
		fmt.Fprintf(stderr, "Starting on %s. Switch models with /model, or run `dari %s --connect` to get auto-routing.\n", models.Default(), agent)
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
