package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/state"
)

func TestListOrganizationsEnsuresManagedKeyWhenCurrentOrgChanges(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())

	expiresAt := time.Now().Add(time.Hour).Unix()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer user-jwt" {
			t.Fatalf("Authorization = %q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/organizations":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"organizations": []map[string]string{{
					"id": "org_new", "name": "New Org", "slug": "new", "role": "owner",
				}},
			})
		case "POST /v1/organizations/org_new/managed-cli-key/ensure":
			_ = json.NewEncoder(w).Encode(map[string]string{"api_key": "dari_new"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	if err := state.Save(&state.CliState{
		APIURL: srv.URL,
		SupabaseSession: &state.SupabaseSession{
			AccessToken:  "user-jwt",
			RefreshToken: "refresh-token",
			ExpiresAt:    &expiresAt,
		},
		CurrentOrgID: "org_old",
		Organizations: map[string]state.Organization{
			"org_old": {ID: "org_old", Name: "Old Org", Slug: "old", Role: "owner", APIKey: "dari_old"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	s, orgs, err := ListOrganizations(t.Context(), srv.URL)
	if err != nil {
		t.Fatalf("ListOrganizations: %v", err)
	}
	if len(orgs) != 1 || orgs[0].ID != "org_new" {
		t.Fatalf("orgs = %#v", orgs)
	}
	org := s.CurrentOrg()
	if org == nil || org.ID != "org_new" || org.APIKey != "dari_new" {
		t.Fatalf("current org = %#v", org)
	}
}

// saveTwoOrgs signs in with org_a current and org_b beside it, holding the
// managed key keyB ("" for none).
func saveTwoOrgs(t *testing.T, apiURL, keyB string, expiresAt time.Time) {
	t.Helper()
	t.Setenv(EnvAPIKey, "")
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	t.Cleanup(func() { state.ActAs("") })
	expires := expiresAt.Unix()
	if err := state.Save(&state.CliState{
		APIURL: apiURL,
		SupabaseSession: &state.SupabaseSession{
			AccessToken:  "user-jwt",
			RefreshToken: "refresh-token",
			ExpiresAt:    &expires,
		},
		CurrentOrgID: "org_a",
		Organizations: map[string]state.Organization{
			"org_a": {ID: "org_a", Name: "Org A", Slug: "a", Role: "owner", APIKey: "dari_a"},
			"org_b": {ID: "org_b", Name: "Org B", Slug: "b", Role: "owner", APIKey: keyB},
		},
	}); err != nil {
		t.Fatal(err)
	}
}

// savedOrgs is the state on disk: the saved current organization, which
// acting as another must not change, and each organization's managed key.
func savedOrgs(t *testing.T) (string, map[string]string) {
	t.Helper()
	s, err := state.Load()
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]string{}
	for id, org := range s.Organizations {
		keys[id] = org.APIKey
	}
	return s.CurrentOrgID, keys
}

func TestActAsUsesTheCachedKeyAndLeavesTheCurrentOrg(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/probe" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"bearer": r.Header.Get("Authorization")})
	}))
	defer srv.Close()
	// An expired sign-in: a cached key needs none.
	saveTwoOrgs(t, srv.URL, "dari_b", time.Now().Add(-time.Hour))

	bearer := func() string {
		t.Helper()
		client, err := OrgKeyClient(srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		var seen struct {
			Bearer string `json:"bearer"`
		}
		if err := client.Do(t.Context(), http.MethodGet, "/probe", nil, &seen); err != nil {
			t.Fatal(err)
		}
		return seen.Bearer
	}
	for _, identifier := range []string{"b", "org_b"} {
		state.ActAs("")
		org, err := ActAs(t.Context(), srv.URL, identifier)
		if err != nil {
			t.Fatalf("ActAs(%q): %v", identifier, err)
		}
		if org.ID != "org_b" || bearer() != "Bearer dari_b" {
			t.Fatalf("ActAs(%q): org = %#v, bearer = %q", identifier, org, bearer())
		}
	}
	if current, keys := savedOrgs(t); current != "org_a" || keys["org_a"] != "dari_a" || keys["org_b"] != "dari_b" {
		t.Fatalf("saved current org = %q, keys = %v", current, keys)
	}
	// Any other process, and this one once it stops acting, is on org_a.
	state.ActAs("")
	if got := bearer(); got != "Bearer dari_a" {
		t.Fatalf("bearer after acting = %q", got)
	}
}

func TestActAsFetchesAMissingKeyOnceWithoutSwitching(t *testing.T) {
	var ensures atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method+" "+r.URL.Path != "POST /v1/organizations/org_b/managed-cli-key/ensure" || r.Header.Get("Authorization") != "Bearer user-jwt" {
			t.Errorf("unexpected request %s %s (%s)", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		// Each ensure revokes the key before it, as the API does.
		_ = json.NewEncoder(w).Encode(map[string]string{"api_key": fmt.Sprintf("dari_b_%d", ensures.Add(1))})
	}))
	defer srv.Close()
	saveTwoOrgs(t, srv.URL, "", time.Now().Add(time.Hour))

	// Launches racing for the same organization, each its own process, fetch
	// one key between them.
	const callers = 8
	start := make(chan struct{})
	errs := make(chan error, callers)
	for range callers {
		go func() {
			<-start
			s, err := ensureStoredOrgKey(t.Context(), srv.URL, "org_b", "")
			if err == nil && s.Organizations["org_b"].APIKey != "dari_b_1" {
				err = fmt.Errorf("key = %q", s.Organizations["org_b"].APIKey)
			}
			errs <- err
		}()
	}
	close(start)
	for range callers {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	org, err := ActAs(t.Context(), srv.URL, "b")
	if err != nil || org.APIKey != "dari_b_1" {
		t.Fatalf("ActAs: org = %#v, err = %v", org, err)
	}
	if got := ensures.Load(); got != 1 {
		t.Fatalf("ensure requests = %d, want 1", got)
	}
	if current, keys := savedOrgs(t); current != "org_a" || keys["org_a"] != "dari_a" || keys["org_b"] != "dari_b_1" {
		t.Fatalf("saved current org = %q, keys = %v", current, keys)
	}
}

func TestActAsFindsAnOrgJoinedSinceTheLastSync(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/organizations":
			_ = json.NewEncoder(w).Encode(map[string]any{"organizations": []map[string]string{
				{"id": "org_a", "name": "Org A", "slug": "a", "role": "owner"},
				{"id": "org_b", "name": "Org B", "slug": "b", "role": "owner"},
				{"id": "org_c", "name": "Org C", "slug": "c", "role": "member"},
			}})
		case "POST /v1/organizations/org_c/managed-cli-key/ensure":
			_ = json.NewEncoder(w).Encode(map[string]string{"api_key": "dari_c"})
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	saveTwoOrgs(t, srv.URL, "dari_b", time.Now().Add(time.Hour))

	if _, err := ActAs(t.Context(), srv.URL, "nowhere"); err == nil || !strings.Contains(err.Error(), `unknown organization "nowhere"`) {
		t.Fatalf("unknown organization: err = %v", err)
	}
	org, err := ActAs(t.Context(), srv.URL, "c")
	if err != nil {
		t.Fatal(err)
	}
	if org.ID != "org_c" || org.APIKey != "dari_c" {
		t.Fatalf("org = %#v", org)
	}
	if current, keys := savedOrgs(t); current != "org_a" || keys["org_a"] != "dari_a" || keys["org_b"] != "dari_b" || keys["org_c"] != "dari_c" {
		t.Fatalf("saved current org = %q, keys = %v", current, keys)
	}
}

func TestActAsNeedsASignInThatStillRefreshes(t *testing.T) {
	supabase := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error_description": "Invalid Refresh Token"})
	}))
	defer supabase.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/config" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"supabase_url": supabase.URL, "supabase_publishable_key": "publishable-key"})
	}))
	defer srv.Close()
	saveTwoOrgs(t, srv.URL, "", time.Now().Add(-time.Hour))

	if _, err := ActAs(t.Context(), srv.URL, "b"); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("expired sign-in: err = %v", err)
	}
	if current, keys := savedOrgs(t); current != "org_a" || keys["org_b"] != "" {
		t.Fatalf("saved current org = %q, keys = %v", current, keys)
	}
	if s, _ := state.Load(); s.CurrentOrg() == nil || s.CurrentOrg().ID != "org_a" {
		t.Fatal("a refused --org left the process acting as it")
	}

	// A machine signed in to another API, and a key in the environment.
	if _, err := ActAs(t.Context(), "https://elsewhere.example", "b"); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("other API: err = %v", err)
	}
	t.Setenv(EnvAPIKey, "dari_env")
	if _, err := ActAs(t.Context(), srv.URL, "b"); !errors.Is(err, ErrNeedsUserLogin) {
		t.Fatalf("DARI_API_KEY: err = %v", err)
	}
}

func TestReplaceOrgKeyKeepsAKeyAnotherProcessStored(t *testing.T) {
	var ensures atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method+" "+r.URL.Path != "POST /v1/organizations/org_b/managed-cli-key/ensure" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		ensures.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]string{"api_key": "dari_b_new"})
	}))
	defer srv.Close()
	saveTwoOrgs(t, srv.URL, "dari_b_refused", time.Now().Add(time.Hour))

	for range 2 {
		// The second caller's refused key was already replaced.
		if err := ReplaceOrgKey(t.Context(), srv.URL, "org_b", "dari_b_refused"); err != nil {
			t.Fatal(err)
		}
	}
	if got := ensures.Load(); got != 1 {
		t.Fatalf("ensure requests = %d, want 1", got)
	}
	if current, keys := savedOrgs(t); current != "org_a" || keys["org_a"] != "dari_a" || keys["org_b"] != "dari_b_new" {
		t.Fatalf("saved current org = %q, keys = %v", current, keys)
	}
}
