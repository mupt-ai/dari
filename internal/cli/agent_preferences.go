package cli

import (
	"context"
	"net/http"
	"net/url"

	"github.com/mupt-ai/dari/internal/api"
)

type agentPreferences struct {
	SubscriptionOptOut bool `json:"subscription_opt_out"`
}

func agentSubscriptionOptedOut(ctx context.Context, client *api.Client, agent string) (bool, error) {
	var preference agentPreferences
	err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/agent-preferences/"+url.PathEscape(agent), nil, &preference)
	return preference.SubscriptionOptOut, api.HumanError(err)
}

func saveAgentSubscriptionOptOut(ctx context.Context, client *api.Client, agent string, optedOut bool) error {
	return api.HumanError(client.Do(ctx, http.MethodPut, "/v1/organizations/current/agent-preferences/"+url.PathEscape(agent), agentPreferences{SubscriptionOptOut: optedOut}, nil))
}
