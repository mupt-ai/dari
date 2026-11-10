package auth

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/state"
)

// OrgRecord is the over-the-wire shape the server uses for orgs.
type OrgRecord struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
	Role string `json:"role"`
}

// organizationsResponse is the shared payload of /v1/me/bootstrap and
// GET /v1/organizations.
type organizationsResponse struct {
	Organizations []OrgRecord `json:"organizations"`
}

type managedKeyResponse struct {
	APIKey string `json:"api_key"`
}

// bootstrapAndSelectOrg is called during Login to populate the org list and
// pick a current org (preferredOrgID wins if set, else the first). It also
// caches the managed CLI key for the selected org.
func bootstrapAndSelectOrg(ctx context.Context, s *state.CliState, apiURL, preferredOrgID string) error {
	if s.SupabaseSession == nil {
		return ErrNotLoggedIn
	}
	var resp organizationsResponse
	client := api.New(apiURL).WithBearer(s.SupabaseSession.AccessToken)
	if err := client.Do(ctx, http.MethodPost, "/v1/me/bootstrap", map[string]any{}, &resp); err != nil {
		return fmt.Errorf("bootstrap user: %w", err)
	}
	syncOrganizations(s, resp.Organizations)

	selected := preferredOrgID
	if selected == "" {
		selected = s.CurrentOrgID
	}
	if _, ok := s.Organizations[selected]; !ok {
		if len(resp.Organizations) == 0 {
			return fmt.Errorf("no organizations are available for this account")
		}
		selected = resp.Organizations[0].ID
	}
	return ensureCurrentOrgKey(ctx, s, apiURL, selected)
}

// ensureCurrentOrgKey fetches or creates the device-bound managed CLI API key
// for orgID and caches it in state.
func ensureCurrentOrgKey(ctx context.Context, s *state.CliState, apiURL, orgID string) error {
	if s.SupabaseSession == nil {
		return ErrNotLoggedIn
	}
	key, err := fetchManagedOrgKey(ctx, apiURL, s.SupabaseSession.AccessToken, orgID)
	if err != nil {
		return err
	}
	return cacheCurrentOrgKey(s, orgID, key)
}

func fetchManagedOrgKey(ctx context.Context, apiURL, accessToken, orgID string) (string, error) {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "dari-cli"
	}
	var issued managedKeyResponse
	path := "/v1/organizations/" + orgID + "/managed-cli-key/ensure"
	client := api.New(apiURL).WithBearer(accessToken)
	if err := client.Do(ctx, http.MethodPost, path, map[string]string{"device_name": hostname}, &issued); err != nil {
		return "", fmt.Errorf("ensure managed CLI key: %w", err)
	}
	return issued.APIKey, nil
}

func cacheCurrentOrgKey(s *state.CliState, orgID, apiKey string) error {
	org, ok := s.Organizations[orgID]
	if !ok {
		return fmt.Errorf("organization %q is not known locally", orgID)
	}
	org.APIKey = apiKey
	s.Organizations[orgID] = org
	s.CurrentOrgID = orgID
	return nil
}

func ensureStoredCurrentOrgKey(ctx context.Context, apiURL, orgID string) (*state.CliState, error) {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "dari-cli"
	}
	var issued managedKeyResponse
	path := "/v1/organizations/" + orgID + "/managed-cli-key/ensure"
	if _, err := DoAuthenticated(ctx, apiURL, http.MethodPost, path, map[string]string{"device_name": hostname}, &issued); err != nil {
		return nil, err
	}
	return updateStoredState(apiURL, func(current *state.CliState) error {
		return cacheCurrentOrgKey(current, orgID, issued.APIKey)
	})
}

// syncOrganizations reconciles a freshly-fetched org list with the locally
// cached managed API keys. Orgs removed server-side are dropped.
func syncOrganizations(s *state.CliState, orgs []OrgRecord) {
	existingKeys := make(map[string]string, len(s.Organizations))
	for id, org := range s.Organizations {
		existingKeys[id] = org.APIKey
	}
	synced := make(map[string]state.Organization, len(orgs))
	for _, o := range orgs {
		synced[o.ID] = state.Organization{
			ID:     o.ID,
			Name:   o.Name,
			Slug:   o.Slug,
			Role:   o.Role,
			APIKey: existingKeys[o.ID],
		}
	}
	s.Organizations = synced
	if _, ok := synced[s.CurrentOrgID]; !ok {
		s.CurrentOrgID = ""
		for id := range synced {
			s.CurrentOrgID = id
			break
		}
	}
}

// ListOrganizations calls GET /v1/organizations, syncs local state, and
// persists. Returns the raw server list (useful for CLI output that includes
// fields beyond what state.Organization tracks).
func ListOrganizations(ctx context.Context, apiURL string) (*state.CliState, []OrgRecord, error) {
	if EnvAPIKeyValue() != "" {
		return nil, nil, ErrNeedsUserLogin
	}
	var resp organizationsResponse
	s, err := DoAuthenticated(ctx, apiURL, http.MethodGet, "/v1/organizations", nil, &resp)
	if err != nil {
		return nil, nil, err
	}
	s, err = updateStoredState(apiURL, func(current *state.CliState) error {
		syncOrganizations(current, resp.Organizations)
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	if org := s.CurrentOrg(); org != nil && org.APIKey == "" {
		s, err = ensureStoredCurrentOrgKey(ctx, apiURL, org.ID)
		if err != nil {
			return nil, nil, err
		}
	}
	return s, resp.Organizations, nil
}

// CreateOrganization creates a new org, caches its managed CLI key, and makes
// it the current org.
func CreateOrganization(ctx context.Context, apiURL, name string) (*state.CliState, error) {
	if EnvAPIKeyValue() != "" {
		return nil, ErrNeedsUserLogin
	}
	var created OrgRecord
	_, err := DoAuthenticated(ctx, apiURL, http.MethodPost, "/v1/organizations", map[string]string{"name": name}, &created)
	if err != nil {
		return nil, err
	}
	if _, err := updateStoredState(apiURL, func(current *state.CliState) error {
		// Upsert manually (not a full sync — we haven't refetched the list).
		current.Organizations[created.ID] = state.Organization{
			ID:     created.ID,
			Name:   created.Name,
			Slug:   created.Slug,
			Role:   created.Role,
			APIKey: current.Organizations[created.ID].APIKey,
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return ensureStoredCurrentOrgKey(ctx, apiURL, created.ID)
}

// SwitchOrganization syncs the org list, matches identifier against id or
// slug, and caches the managed key for the match.
func SwitchOrganization(ctx context.Context, apiURL, identifier string) (*state.CliState, error) {
	if EnvAPIKeyValue() != "" {
		return nil, ErrNeedsUserLogin
	}
	_, orgs, err := ListOrganizations(ctx, apiURL)
	if err != nil {
		return nil, err
	}
	matched, err := findOrgRecord(orgs, identifier)
	if err != nil {
		return nil, err
	}
	return ensureStoredCurrentOrgKey(ctx, apiURL, matched.ID)
}

// DeleteOrganization soft-deletes the organization identified by id or slug
// and updates local state so the org no longer shows up as current.
func DeleteOrganization(ctx context.Context, apiURL, identifier string) (*state.CliState, OrgRecord, error) {
	if EnvAPIKeyValue() != "" {
		return nil, OrgRecord{}, ErrNeedsUserLogin
	}
	s, orgs, err := ListOrganizations(ctx, apiURL)
	if err != nil {
		return nil, OrgRecord{}, err
	}
	matched, err := findOrgRecord(orgs, identifier)
	if err != nil {
		return nil, OrgRecord{}, err
	}
	var deleted OrgRecord
	if _, err := DoAuthenticated(ctx, apiURL, http.MethodDelete, "/v1/organizations/"+matched.ID, nil, &deleted); err != nil {
		return nil, OrgRecord{}, err
	}
	s, err = updateStoredState(apiURL, func(current *state.CliState) error {
		delete(current.Organizations, matched.ID)
		if current.CurrentOrgID == matched.ID {
			current.CurrentOrgID = ""
			for id := range current.Organizations {
				current.CurrentOrgID = id
				break
			}
		}
		return nil
	})
	if err != nil {
		return nil, OrgRecord{}, err
	}
	return s, matched, nil
}

func updateStoredState(apiURL string, update func(*state.CliState) error) (*state.CliState, error) {
	var updated *state.CliState
	err := state.Update(func(s *state.CliState) error {
		if !api.URLsMatch(s.APIURL, apiURL) || s.SupabaseSession == nil {
			return ErrNotLoggedIn
		}
		if err := update(s); err != nil {
			return err
		}
		updated = s
		return nil
	})
	return updated, err
}

// findOrgRecord matches identifier against an org's id or slug.
func findOrgRecord(orgs []OrgRecord, identifier string) (OrgRecord, error) {
	for _, org := range orgs {
		if org.ID == identifier || org.Slug == identifier {
			return org, nil
		}
	}
	return OrgRecord{}, fmt.Errorf("unknown organization %q", identifier)
}
