package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DARI_CONFIG_DIR", dir)
	unsetXDG(t)

	exp := int64(1704067200)
	original := &CliState{
		APIURL: "https://api.dari.dev",
		SupabaseSession: &SupabaseSession{
			AccessToken:  "access-1",
			RefreshToken: "refresh-1",
			ExpiresAt:    &exp,
			UserID:       "user-1",
			Email:        "user@example.com",
			DisplayName:  "Dari User",
		},
		CurrentOrgID: "org-1",
		Organizations: map[string]Organization{
			"org-1": {ID: "org-1", Name: "Acme", Slug: "acme", Role: "owner", APIKey: "dari_abc"},
			"org-2": {ID: "org-2", Name: "Other", Slug: "other", Role: "member"},
		},
	}

	if err := Save(original); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.APIURL != original.APIURL {
		t.Errorf("APIURL: got %q want %q", loaded.APIURL, original.APIURL)
	}
	if loaded.CurrentOrgID != original.CurrentOrgID {
		t.Errorf("CurrentOrgID: got %q want %q", loaded.CurrentOrgID, original.CurrentOrgID)
	}
	if loaded.SupabaseSession == nil || loaded.SupabaseSession.Email != "user@example.com" {
		t.Errorf("session: %+v", loaded.SupabaseSession)
	}
	if got, want := len(loaded.Organizations), 2; got != want {
		t.Errorf("organizations: got %d want %d", got, want)
	}
	if loaded.Organizations["org-1"].APIKey != "dari_abc" {
		t.Errorf("org-1 api_key: %q", loaded.Organizations["org-1"].APIKey)
	}
}

func TestConcurrentUpdatesDoNotLoseChanges(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DARI_CONFIG_DIR", dir)
	unsetXDG(t)

	if err := Save(&CliState{Organizations: map[string]Organization{}}); err != nil {
		t.Fatal(err)
	}

	const updates = 20
	var wg sync.WaitGroup
	errs := make(chan error, updates)
	for i := range updates {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- Update(func(s *CliState) error {
				id := string(rune('a' + i))
				s.Organizations[id] = Organization{ID: id}
				return nil
			})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("Update: %v", err)
		}
	}

	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := len(s.Organizations); got != updates {
		t.Fatalf("organization count = %d, want %d", got, updates)
	}
	matches, err := filepath.Glob(filepath.Join(dir, ".state-*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary state files remain: %v", matches)
	}
}

func TestLoadMissingReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DARI_CONFIG_DIR", dir)
	unsetXDG(t)

	s, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.APIURL != "" || s.SupabaseSession != nil || s.CurrentOrgID != "" {
		t.Errorf("expected empty state, got %+v", s)
	}
	if len(s.Organizations) != 0 {
		t.Errorf("expected empty orgs, got %v", s.Organizations)
	}
}

// Simulate a Python-written state.json — the Go reader must accept it.
func TestLoadPythonWrittenState(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DARI_CONFIG_DIR", dir)
	unsetXDG(t)

	pythonJSON := `{
  "schema_version": 1,
  "api_url": "https://api.dari.dev",
  "supabase_session": {
    "access_token": "tok",
    "refresh_token": "ref",
    "expires_at": 1700000000,
    "user_id": "u1",
    "email": "u@example.com",
    "display_name": null
  },
  "current_org_id": "org-1",
  "organizations": {
    "org-1": {
      "id": "org-1",
      "name": "Org",
      "slug": "org",
      "role": "owner",
      "api_key": null
    }
  }
}`
	path, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(pythonJSON), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	s, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.APIURL != "https://api.dari.dev" {
		t.Errorf("APIURL: %q", s.APIURL)
	}
	if s.SupabaseSession == nil || s.SupabaseSession.Email != "u@example.com" {
		t.Errorf("session: %+v", s.SupabaseSession)
	}
	if s.SupabaseSession.DisplayName != "" {
		t.Errorf("display_name: %q", s.SupabaseSession.DisplayName)
	}
	org := s.CurrentOrg()
	if org == nil || org.APIKey != "" {
		t.Errorf("current org: %+v", org)
	}
}

func TestSaveReplacesCorruptState(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DARI_CONFIG_DIR", dir)
	unsetXDG(t)

	path, err := Path()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Save(&CliState{APIURL: "https://api.dari.dev", Organizations: map[string]Organization{}}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := Load(); err != nil {
		t.Fatalf("Load after Save: %v", err)
	}
}

func TestUnsupportedSchemaVersion(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DARI_CONFIG_DIR", dir)
	unsetXDG(t)

	blob := map[string]any{"schema_version": 99, "organizations": map[string]any{}}
	data, _ := json.Marshal(blob)
	path, _ := Path()
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	_ = os.WriteFile(path, data, 0o600)

	if _, err := Load(); err == nil {
		t.Fatal("expected error for unsupported schema")
	}
}

func TestPathPrecedence(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	t.Setenv("DARI_CONFIG_DIR", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("APPDATA", "")
	got, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	want := filepath.Join(home, ".config", "dari", "state.json")
	if got != want {
		t.Errorf("default: got %q want %q", got, want)
	}

	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg")
	got, _ = Path()
	if got != "/tmp/xdg/dari/state.json" {
		t.Errorf("xdg: got %q", got)
	}

	t.Setenv("DARI_CONFIG_DIR", "/tmp/explicit")
	got, _ = Path()
	if got != "/tmp/explicit/state.json" {
		t.Errorf("explicit: got %q", got)
	}
}

func unsetXDG(t *testing.T) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("APPDATA", "")
}
