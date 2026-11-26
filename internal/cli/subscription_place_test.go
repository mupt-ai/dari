package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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
		place, err := chooseSubscriptionPlace(strings.NewReader(""), &strings.Builder{}, provider, "")
		if err != nil || string(place) != strings.Fields(want)[0] {
			t.Fatalf("%s: %s %v", provider.name, place, err)
		}
	}
	if _, err := chooseSubscriptionPlace(nil, nil, claudeSubscription, "cloud"); err == nil {
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

func TestSubscriptionWhereListsEveryComputerHoldingTheAccount(t *testing.T) {
	id := "acct-1"
	email, upper, other := "me@example.com", "Me@Example.com", "other@example.com"
	plan := subscriptionCredential{
		ID:            "local-1",
		OAuthProvider: "openai_codex",
		SafeMetadata:  map[string]string{"account_email": "me@example.com"},
		place:         placeComputer,
	}
	reported := []localSubscription{
		{GatewayID: "here", GatewayName: "mac.higgins.home", LocalID: "local-1", Provider: "openai_codex", AccountID: &id, AccountEmail: &email},
		{GatewayID: "mini", GatewayName: "Mac mini", Provider: "openai_codex", AccountID: &id},
		{GatewayID: "laptop", GatewayName: "Laptop", Provider: "openai_codex", AccountEmail: &upper},
		{GatewayID: "studio", GatewayName: "Studio", Provider: "openai_codex", AccountEmail: &other},
		{GatewayID: "box", GatewayName: "Box", Provider: "anthropic_claude_code", AccountID: &id},
	}
	plan.otherComputers = otherComputers(plan, reported, "here")
	// The laptop's copy has no id, so its email matches in any case.
	want := " " + ansiGray + "This Computer · Laptop · Mac mini" + ansiReset
	if got := subscriptionWhere(plan); got != want {
		t.Fatalf("subscriptionWhere = %q, want %q", got, want)
	}
}

// planServer serves credentials as a hosted Dari or gateway subscription API
// would, logging each request and its body. A sign-in connects signedInAs, an
// email, and signedInAccount when it is not empty.
func planServer(t *testing.T, listing map[string]any, signedInAs string, log *[]string, bodies map[string]map[string]any, signedInAccount ...string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := r.Method + " " + r.URL.Path
		*log = append(*log, request)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies[request] = body
		switch {
		case request == "GET /v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(listing)
		case request == "POST /v1/organizations/current/credentials/oauth/sessions":
			_ = json.NewEncoder(w).Encode(agentSubscriptionOAuthStart{
				SessionToken: "session", AuthorizationURL: "https://auth.openai.com/codex/device", UserCode: "ABCD-EFGH",
			})
		case request == "POST /v1/organizations/current/credentials/oauth/sessions/complete":
			metadata := map[string]any{"account_email": signedInAs}
			if len(signedInAccount) > 0 {
				metadata["account_id"] = signedInAccount[0]
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name": "OPENAI_CODEX_OAUTH_TOKEN_2", "oauth_provider": "openai_codex",
				"safe_metadata": metadata,
			})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "ok"})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// connectCodex runs `dari accounts subscription connect codex --on <on>`
// against hosted, with this computer's gateway served by computer, answering
// each offer to move a plan with move.
func connectCodex(t *testing.T, hosted, computer *httptest.Server, on string, move bool) string {
	t.Helper()
	original, browser, confirm := computerClient, openAgentBrowser, confirmMove
	computerClient = func(context.Context, io.Reader, io.Writer, bool) (*api.Client, error) {
		return api.New(computer.URL), nil
	}
	openAgentBrowser = func(string) bool { return false }
	confirmMove = func(_ io.Reader, stderr io.Writer, s placedSubscription, place subscriptionPlace) (bool, error) {
		fmt.Fprintf(stderr, "offered %s from %s to %s\n", subscriptionName(s.subscriptionCredential), s.where, placeNames[place])
		return move, nil
	}
	t.Cleanup(func() { computerClient, openAgentBrowser, confirmMove = original, browser, confirm })
	var stderr strings.Builder
	cmd := newRootCmd("dev")
	// Enter once the device code is approved.
	cmd.SetIn(strings.NewReader("\n"))
	cmd.SetErr(&stderr)
	cmd.SetArgs([]string{"--api-url", hosted.URL, "accounts", "subscription", "connect", "codex", "--on", on})
	if err := captureStdout(t, cmd.Execute); err != nil {
		t.Fatalf("connect: %v\n%s", err, stderr.String())
	}
	return stderr.String()
}

var codexOnDari = map[string]any{"credentials": []any{map[string]any{
	"name": "OPENAI_CODEX_OAUTH_TOKEN", "credential_scope": "user", "oauth_provider": "openai_codex",
	"safe_metadata": map[string]any{"account_email": "me@example.test"},
}}}

func TestConnectMovesAPlanOnDariToThisComputer(t *testing.T) {
	useTestAPIKey(t)
	var log []string
	bodies := map[string]map[string]any{}
	hosted := planServer(t, codexOnDari, "", &log, bodies)
	computer := planServer(t, nil, "ME@example.test", &log, bodies)

	stderr := connectCodex(t, hosted, computer, "computer", true)
	if !strings.Contains(stderr, "offered me@example.test from Dari to This Computer") ||
		!strings.Contains(stderr, "me@example.test moved from Dari to This Computer") {
		t.Fatalf("stderr = %s", stderr)
	}
	if started := bodies["POST /v1/organizations/current/credentials/oauth/sessions"]; started["moving_from"] != "OPENAI_CODEX_OAUTH_TOKEN" {
		t.Fatalf("start body = %#v, want moving_from", started)
	}
	// The plan on Dari is disconnected only once the sign-in here completes.
	if last := log[len(log)-1]; last != "DELETE /v1/organizations/current/credentials/OPENAI_CODEX_OAUTH_TOKEN" ||
		log[len(log)-2] != "POST /v1/organizations/current/credentials/oauth/sessions/complete" {
		t.Fatalf("requests = %v", log)
	}
}

func TestConnectAnotherAccountLeavesThePlanOnDari(t *testing.T) {
	useTestAPIKey(t)
	var log []string
	bodies := map[string]map[string]any{}
	hosted := planServer(t, codexOnDari, "", &log, bodies)
	computer := planServer(t, nil, "other@example.test", &log, bodies)

	connectCodex(t, hosted, computer, "computer", false)
	if started := bodies["POST /v1/organizations/current/credentials/oauth/sessions"]; started == nil || started["moving_from"] != nil {
		t.Fatalf("start body = %#v, want no moving_from", started)
	}
	for _, request := range log {
		if strings.HasPrefix(request, "DELETE ") {
			t.Fatalf("disconnected a plan: %v", log)
		}
	}
}

func TestConnectPrivatelyFlipsAPlanOnThisComputerWithoutSigningIn(t *testing.T) {
	useTestAPIKey(t)
	if err := gateway.Save(gateway.Settings{Mode: gateway.ModeHosted, GatewayID: "gw_here", LocalKey: "local", EncryptionKey: "k"}); err != nil {
		t.Fatal(err)
	}
	var log []string
	bodies := map[string]map[string]any{}
	hosted := planServer(t, map[string]any{"credentials": []any{}, "local_subscriptions": []any{
		map[string]any{"gateway_id": "gw_here", "local_id": "local-1", "provider": "openai_codex"},
	}}, "", &log, bodies)
	computer := planServer(t, map[string]any{"credentials": []any{map[string]any{
		"id": "local-1", "name": "OPENAI_CODEX_OAUTH_TOKEN", "credential_scope": "user", "oauth_provider": "openai_codex",
		"safe_metadata": map[string]any{"account_email": "me@example.test"},
	}}}, "", &log, bodies)

	stderr := connectCodex(t, hosted, computer, "private", true)
	if !strings.Contains(stderr, "me@example.test moved from This Computer to Private") {
		t.Fatalf("stderr = %s", stderr)
	}
	if body := bodies["PUT /v1/organizations/current/credentials/OPENAI_CODEX_OAUTH_TOKEN/private"]; body["private"] != true {
		t.Fatalf("private body = %#v (requests %v)", body, log)
	}
	if _, ok := bodies["POST /v1/organizations/current/credentials/oauth/sessions"]; ok {
		t.Fatalf("signed in again: %v", log)
	}
}

func TestMoveKeepsTheOldPlanWhenAnotherAccountSignsIn(t *testing.T) {
	useTestAPIKey(t)
	var log []string
	bodies := map[string]map[string]any{}
	hosted := planServer(t, codexOnDari, "", &log, bodies)
	computer := planServer(t, nil, "other@example.test", &log, bodies)

	stderr := connectCodex(t, hosted, computer, "computer", true)
	if !strings.Contains(stderr, "Signed in to another account; kept me@example.test on Dari") || strings.Contains(stderr, "moved") {
		t.Fatalf("stderr = %s", stderr)
	}
	for _, request := range log {
		if strings.HasPrefix(request, "DELETE ") {
			t.Fatalf("disconnected the old plan: %v", log)
		}
	}
}

// One email can hold several ChatGPT workspaces: a sign-in to another
// workspace of the same email is another account, and the old plan stays.
func TestMoveKeepsTheOldPlanWhenAnotherWorkspaceSignsIn(t *testing.T) {
	useTestAPIKey(t)
	var log []string
	bodies := map[string]map[string]any{}
	onDari := map[string]any{"credentials": []any{map[string]any{
		"name": "OPENAI_CODEX_OAUTH_TOKEN", "credential_scope": "user", "oauth_provider": "openai_codex",
		"safe_metadata": map[string]any{"account_email": "me@example.test", "workspace_id": "ws_team"},
	}}}
	hosted := planServer(t, onDari, "", &log, bodies)
	computer := planServer(t, nil, "me@example.test", &log, bodies, "ws_personal")

	stderr := connectCodex(t, hosted, computer, "computer", true)
	if !strings.Contains(stderr, "Signed in to another account") {
		t.Fatalf("stderr = %s", stderr)
	}
	for _, request := range log {
		if strings.HasPrefix(request, "DELETE ") {
			t.Fatalf("disconnected the old plan: %v", log)
		}
	}
}
