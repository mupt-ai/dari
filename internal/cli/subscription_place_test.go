package cli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/gateway"
)

func TestSubscriptionPlacesOfferEachProvidersDefaultFirst(t *testing.T) {
	for provider, want := range map[agentSubscriptionProvider]string{
		claudeSubscription: "computer dari private",
		museSubscription:   "computer dari private",
		codexSubscription:  "dari computer private",
		grokSubscription:   "dari computer private",
	} {
		places := []string{}
		for _, place := range subscriptionPlaces(provider) {
			places = append(places, string(place))
		}
		if got := strings.Join(places, " "); got != want {
			t.Fatalf("%s: %s, want %s", provider.name, got, want)
		}
		// Without a terminal the default is taken.
		place, err := chooseSubscriptionPlace(strings.NewReader(""), &strings.Builder{}, provider, "", "")
		if err != nil || string(place) != strings.Fields(want)[0] {
			t.Fatalf("%s: %s %v", provider.name, place, err)
		}
	}
	if _, err := chooseSubscriptionPlace(nil, nil, claudeSubscription, "cloud", ""); err == nil {
		t.Fatal("accepted --on cloud")
	}
}

func TestFindPlacedSubscriptionAsksWhereWhenBothPlacesMatch(t *testing.T) {
	all := []placedSubscription{
		{subscriptionCredential{Name: "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN", OAuthProvider: claudeSubscription.id}, placeDari, "Dari"},
		{subscriptionCredential{Name: "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN", OAuthProvider: claudeSubscription.id}, placePrivate, "Private"},
		{subscriptionCredential{Name: "cred_other", OAuthProvider: codexSubscription.id}, "", "laptop"},
	}
	if _, err := findPlacedSubscription(all, "claude-code", ""); err == nil || !strings.Contains(err.Error(), "--on dari or --on computer") {
		t.Fatalf("err = %v", err)
	}
	found, err := findPlacedSubscription(all, "anthropic_claude_code_oauth_token", "computer")
	if err != nil || found.place != placePrivate {
		t.Fatalf("found %+v, %v", found, err)
	}
	// Another computer's plan is managed there.
	if _, err := findPlacedSubscription(all, "codex", ""); err == nil {
		t.Fatal("found another computer's plan")
	}
}

func TestPlansOnThisComputerCountAsConnected(t *testing.T) {
	useTestAPIKey(t)
	if err := gateway.Save(gateway.Settings{Mode: gateway.ModeHosted, GatewayID: "gw_here", EncryptionKey: "k"}); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"credentials":[],"local_subscriptions":[
			{"gateway_id":"gw_here","provider":"anthropic_claude_code"},
			{"gateway_id":"gw_elsewhere","provider":"meta_muse"}]}`))
	}))
	defer srv.Close()
	connected, err := connectedAgentSubscriptions(context.Background(), api.New(srv.URL), []agentSubscriptionProvider{claudeSubscription, museSubscription})
	if err != nil || len(connected) != 1 || connected[0].id != claudeSubscription.id {
		t.Fatalf("connected = %+v, %v", connected, err)
	}
}
