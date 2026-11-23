package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/codex"
	"github.com/mupt-ai/dari/internal/state"
)

// signInToTwoOrgs is a hosted machine signed in with org_a current and org_b
// beside it, each with its managed key cached.
func signInToTwoOrgs(t *testing.T, apiURL string) {
	t.Helper()
	setGatewayEnv(t, "")
	t.Setenv("DARI_GATEWAY_KEY", "")
	t.Setenv("DARI_API_URL", apiURL)
	t.Setenv(launchedRoutingKeyEnv, "")
	t.Cleanup(func() { state.ActAs("") })
	expires := time.Now().Add(time.Hour).Unix()
	if err := state.Save(&state.CliState{
		APIURL:          apiURL,
		SupabaseSession: &state.SupabaseSession{AccessToken: "user-jwt", RefreshToken: "refresh-token", ExpiresAt: &expires},
		CurrentOrgID:    "org_a",
		Organizations: map[string]state.Organization{
			"org_a": {ID: "org_a", Name: "Org A", Slug: "a", Role: "owner", APIKey: "dari_a"},
			"org_b": {ID: "org_b", Name: "Org B", Slug: "b", Role: "owner", APIKey: "dari_b"},
		},
	}); err != nil {
		t.Fatal(err)
	}
}

// savedCurrentOrg is the current organization on disk, which every other
// process sees.
func savedCurrentOrg(t *testing.T) string {
	t.Helper()
	s, err := state.Load()
	if err != nil {
		t.Fatal(err)
	}
	return s.CurrentOrgID
}

func TestLaunchTakesOrgOutOfTheAgentArguments(t *testing.T) {
	for _, tc := range []struct {
		args            string
		org, router     string
		kept, wantError string
	}{
		{args: "--org acme -p hi", org: "acme", kept: "-p hi"},
		{args: "-p --org=org_123 hi", org: "org_123", kept: "-p hi"},
		{args: "--router rtr_1 --org acme exec hi", org: "acme", router: "rtr_1", kept: "exec hi"},
		{args: "--org acme --router rtr_1", org: "acme", router: "rtr_1"},
		// After --, it is the agent's own argument.
		{args: "-p -- --org acme", kept: "-p -- --org acme"},
		{args: "exec --org", wantError: "--org needs an organization"},
		{args: "--org= exec", wantError: "--org needs an organization"},
		{args: "--org acme --default", wantError: "--pay and --default go with --router"},
	} {
		launch := agentLaunch{name: "codex", args: strings.Fields(tc.args)}
		choice, err := takeAgentRouterChoice(&launch)
		if tc.wantError != "" {
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Errorf("%q: err = %v, want %q", tc.args, err, tc.wantError)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: %v", tc.args, err)
			continue
		}
		if choice.org != tc.org || choice.name != tc.router || strings.Join(launch.args, " ") != tc.kept {
			t.Errorf("%q: org = %q, router = %q, args = %q", tc.args, choice.org, choice.name, launch.args)
		}
	}
}

// --org changes one launch and nothing else, so it refuses what would outlast
// the launch or name a second organization, before anything is asked of Dari.
func TestLaunchOrgRefusals(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}))
	defer api.Close()

	for _, tc := range []struct {
		name    string
		arrange func(t *testing.T)
		choice  agentRouterChoice
		want    string
	}{
		{name: "default", choice: agentRouterChoice{org: "b", name: "rtr_b", makeDefault: true}, want: "leave out --default"},
		{name: "management key", arrange: func(t *testing.T) { t.Setenv("DARI_API_KEY", "dari_env") }, choice: agentRouterChoice{org: "b"}, want: "DARI_API_KEY is one organization's key already"},
		{name: "routing key", arrange: func(t *testing.T) { t.Setenv(agents.RoutingAPIKeyEnv, "dari_route_env") }, choice: agentRouterChoice{org: "b"}, want: agents.RoutingAPIKeyEnv + " sets another"},
		{name: "gateway", arrange: func(t *testing.T) { setGatewayEnv(t, "http://127.0.0.1:1") }, choice: agentRouterChoice{org: "b"}, want: "a gateway has no organizations"},
		{name: "signed out", arrange: func(t *testing.T) { t.Setenv("DARI_CONFIG_DIR", t.TempDir()) }, choice: agentRouterChoice{org: "b"}, want: "dari auth login"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			signInToTwoOrgs(t, api.URL)
			if tc.arrange != nil {
				tc.arrange(t)
			}
			err := useLaunchOrg(context.Background(), tc.choice, io.Discard)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if s, _ := state.Load(); s.CurrentOrg() != nil && s.CurrentOrg().ID == "org_b" {
				t.Fatal("a refused --org left the launch on that organization")
			}
		})
	}

	// A routing key a parent Dari launch handed down is not the user's choice.
	signInToTwoOrgs(t, api.URL)
	t.Setenv(agents.RoutingAPIKeyEnv, "dari_parent")
	t.Setenv(launchedRoutingKeyEnv, "1")
	var output strings.Builder
	if err := useLaunchOrg(context.Background(), agentRouterChoice{org: "b"}, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Organization: Org B (this launch only)") {
		t.Fatalf("output = %q", output.String())
	}
}

// A launch with --org asks Dari as that organization and routes with that
// organization's own routing key, while the saved current organization, and
// so every launch without the flag, stays where it was.
func TestLaunchOrgRoutesAsThatOrgOnly(t *testing.T) {
	var mu sync.Mutex
	var bearers []string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method+" "+r.URL.Path != "POST /v1/organizations/current/api-keys" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		bearers = append(bearers, r.Header.Get("Authorization"))
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{"api_key": "route_for_" + strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")})
	}))
	defer api.Close()
	signInToTwoOrgs(t, api.URL)

	if err := useLaunchOrg(context.Background(), agentRouterChoice{org: "b"}, io.Discard); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		access, err := resolveAgentRoutingAccess(context.Background(), strings.NewReader(""), io.Discard)
		if err != nil {
			t.Fatal(err)
		}
		if access.key != "route_for_dari_b" || access.scope != api.URL+"|org:org_b" {
			t.Fatalf("access = %+v", access)
		}
	}
	if current := savedCurrentOrg(t); current != "org_a" {
		t.Fatalf("saved current org = %q", current)
	}

	// The next launch without the flag, a process of its own.
	state.ActAs("")
	access, err := resolveAgentRoutingAccess(context.Background(), strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if access.key != "route_for_dari_a" || access.scope != api.URL+"|org:org_a" {
		t.Fatalf("access without --org = %+v", access)
	}
	if want := []string{"Bearer dari_b", "Bearer dari_a"}; !slices.Equal(bearers, want) {
		t.Fatalf("routing keys issued as %v, want %v", bearers, want)
	}
}

// A managed key the API refuses is replaced for the launch's organization
// without switching to it, and without touching the current organization's.
func TestLaunchOrgReplacesARefusedKeyWithoutSwitching(t *testing.T) {
	var requests []string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bearer := r.Header.Get("Authorization")
		requests = append(requests, r.Method+" "+r.URL.Path+" "+bearer)
		switch {
		case r.URL.Path == "/v1/organizations/current/api-keys" && bearer == "Bearer dari_b":
			w.WriteHeader(http.StatusUnauthorized)
		case r.URL.Path == "/v1/organizations/current/api-keys" && bearer == "Bearer dari_b_new":
			_ = json.NewEncoder(w).Encode(map[string]string{"api_key": "route_b"})
		case r.URL.Path == "/v1/organizations/org_b/managed-cli-key/ensure" && bearer == "Bearer user-jwt":
			_ = json.NewEncoder(w).Encode(map[string]string{"api_key": "dari_b_new"})
		default:
			t.Errorf("unexpected request %s %s (%s)", r.Method, r.URL.Path, bearer)
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	signInToTwoOrgs(t, api.URL)

	if err := useLaunchOrg(context.Background(), agentRouterChoice{org: "org_b"}, io.Discard); err != nil {
		t.Fatal(err)
	}
	access, err := resolveAgentRoutingAccess(context.Background(), strings.NewReader(""), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if access.key != "route_b" || len(requests) != 3 {
		t.Fatalf("key = %q, requests = %v", access.key, requests)
	}
	state.ActAs("")
	s, err := state.Load()
	if err != nil {
		t.Fatal(err)
	}
	if s.CurrentOrgID != "org_a" || s.Organizations["org_a"].APIKey != "dari_a" || s.Organizations["org_b"].APIKey != "dari_b_new" {
		t.Fatalf("saved current org = %q, orgs = %+v", s.CurrentOrgID, s.Organizations)
	}
}

// routingServedBy sends requests for hosted Dari routing to server.
func routingServedBy(t *testing.T, server *httptest.Server) {
	t.Helper()
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	routing, err := url.Parse(routingBaseURL)
	if err != nil {
		t.Fatal(err)
	}
	original := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != routing.Host {
			return original.RoundTrip(r)
		}
		redirected := r.Clone(r.Context())
		redirected.URL.Scheme, redirected.URL.Host, redirected.Host = target.Scheme, target.Host, target.Host
		return original.RoundTrip(redirected)
	})
	t.Cleanup(func() { http.DefaultTransport = original })
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Codex is set up to run directly on org_a. A launch on org_b's router, which
// is Codex's default there, routes with org_b's key and leaves that setup
// alone; the same launch in the current organization moves the setup, which
// is what --org must not do.
func TestLaunchOrgLeavesTheAgentRunDirectlyAlone(t *testing.T) {
	routing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		// Each organization's routing key opens only its own router.
		if r.URL.Path != "/rtr_"+strings.TrimPrefix(key, "route_")+"/v1/models" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = io.WriteString(w, `{"models":[{"slug":"dari/routing","context_window":272000}]}`)
	}))
	defer routing.Close()
	routingServedBy(t, routing)
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		org := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer dari_")
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/organizations/current/api-keys":
			_ = json.NewEncoder(w).Encode(map[string]string{"api_key": "route_" + org})
		case "GET /v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{
				{"id": "rtr_" + org, "name": "Codex", "coding_agents": []string{"codex"}},
			}})
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	signInToTwoOrgs(t, api.URL)
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	if err := codex.Setup(home, routingBaseURL+"/rtr_a", "route_a", agents.RoutingModel, []byte(`{"models":[]}`), "", false, false); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(home, "config.toml")
	before, err := os.ReadFile(config)
	if err != nil {
		t.Fatal(err)
	}

	var output strings.Builder
	launch := agentLaunch{name: "codex", args: []string{"--org", "b", "--router", "rtr_b", "exec", "hi"}}
	key, baseURL, _, err := resolveAgentRouting(context.Background(), &launch, strings.NewReader(""), &output)
	if err != nil {
		t.Fatal(err)
	}
	if key != "route_b" || baseURL != routingBaseURL+"/rtr_b" || strings.Join(launch.args, " ") != "exec hi" {
		t.Fatalf("key = %q, baseURL = %q, args = %q", key, baseURL, launch.args)
	}
	after, err := os.ReadFile(config)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) || strings.Contains(output.String(), "Codex") {
		t.Fatalf("--org touched Codex run directly: %s\n%s", output.String(), after)
	}
	if current := savedCurrentOrg(t); current != "org_a" {
		t.Fatalf("saved current org = %q", current)
	}

	// Without --org, in the current organization, the setup follows.
	state.ActAs("")
	output.Reset()
	launch = agentLaunch{name: "codex", args: []string{"--router", "rtr_a", "exec", "hi"}}
	if key, _, _, err = resolveAgentRouting(context.Background(), &launch, strings.NewReader(""), &output); err != nil || key != "route_a" {
		t.Fatalf("key = %q, err = %v", key, err)
	}
	if !strings.Contains(output.String(), "Codex") {
		t.Fatalf("a launch in the current organization left Codex run directly behind: %q", output.String())
	}
}

// OpenClaw and Hermes route on the setup in their own config, which one
// launch cannot move to another organization: --org is refused rather than
// handed to the agent as an argument of its own.
func TestLaunchOrgIsRefusedForAgentsThatRouteOnTheirSetup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake agent executable is a shell script")
	}
	setGatewayEnv(t, "")
	record := filepath.Join(t.TempDir(), "launch.txt")
	script := filepath.Join(t.TempDir(), "agent")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho started >> \""+record+"\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"openclaw", "hermes"} {
		t.Setenv("DARI_"+strings.ToUpper(name)+"_PATH", script)
		for _, args := range [][]string{{"--org", "b", "chat"}, {"chat", "--org=b"}} {
			var stderr strings.Builder
			code := runAgentLaunch(context.Background(), agentLaunch{name: name, args: args}, strings.NewReader(""), io.Discard, &stderr)
			if code != 1 || !strings.Contains(stderr.String(), "--org does not apply") {
				t.Fatalf("%s %v: exit %d, stderr %q", name, args, code, stderr.String())
			}
		}
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatalf("an agent started with --org: %v", err)
	}
}
