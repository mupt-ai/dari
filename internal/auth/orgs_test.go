package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
