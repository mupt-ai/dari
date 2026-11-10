package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/state"
)

func TestLogoutRevokesOnlyTheStoredSession(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())

	var logoutScope string
	supabase := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		logoutScope = r.URL.Query().Get("scope")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer supabase.Close()
	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"supabase_url":             supabase.URL,
			"supabase_publishable_key": "publishable-key",
		})
	}))
	defer apiServer.Close()

	expiresAt := time.Now().Add(time.Hour).Unix()
	if err := state.Save(&state.CliState{
		APIURL: apiServer.URL,
		SupabaseSession: &state.SupabaseSession{
			AccessToken:  "access",
			RefreshToken: "refresh",
			ExpiresAt:    &expiresAt,
		},
		Organizations: map[string]state.Organization{},
	}); err != nil {
		t.Fatal(err)
	}
	if err := Logout(t.Context(), apiServer.URL); err != nil {
		t.Fatal(err)
	}
	if logoutScope != "local" {
		t.Fatalf("logout scope = %q, want local", logoutScope)
	}
	s, err := state.Load()
	if err != nil {
		t.Fatal(err)
	}
	if s.SupabaseSession != nil {
		t.Fatal("stored session was not cleared")
	}
}

func TestDoAuthenticatedSerializesConcurrentRefresh(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())

	var refreshes atomic.Int32
	supabase := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/v1/token" {
			t.Fatalf("unexpected Supabase request %s", r.URL.Path)
		}
		refreshes.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "new-access",
			"refresh_token": "new-refresh",
			"expires_at":    time.Now().Add(time.Hour).Unix(),
			"user": map[string]string{
				"id":    "user-1",
				"email": "user@example.com",
			},
		})
	}))
	defer supabase.Close()

	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/auth/config":
			_ = json.NewEncoder(w).Encode(map[string]string{
				"supabase_url":             supabase.URL,
				"supabase_publishable_key": "publishable-key",
			})
		case "/protected":
			if got := r.Header.Get("Authorization"); got != "Bearer new-access" {
				t.Errorf("Authorization = %q", got)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			t.Fatalf("unexpected API request %s", r.URL.Path)
		}
	}))
	defer apiServer.Close()

	expired := time.Now().Add(-time.Hour).Unix()
	if err := state.Save(&state.CliState{
		APIURL: apiServer.URL,
		SupabaseSession: &state.SupabaseSession{
			AccessToken:  "old-access",
			RefreshToken: "old-refresh",
			ExpiresAt:    &expired,
		},
		Organizations: map[string]state.Organization{},
	}); err != nil {
		t.Fatal(err)
	}

	const callers = 8
	start := make(chan struct{})
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			var response struct {
				OK bool `json:"ok"`
			}
			_, err := DoAuthenticated(t.Context(), apiServer.URL, http.MethodGet, "/protected", nil, &response)
			if err == nil && !response.OK {
				err = errors.New("response was not successful")
			}
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("DoAuthenticated: %v", err)
		}
	}
	if got := refreshes.Load(); got != 1 {
		t.Fatalf("refresh requests = %d, want 1", got)
	}

	s, err := state.Load()
	if err != nil {
		t.Fatal(err)
	}
	if s.SupabaseSession.RefreshToken != "new-refresh" {
		t.Fatalf("stored refresh token = %q", s.SupabaseSession.RefreshToken)
	}
}

func TestDoAuthenticatedSerializesConcurrentReactiveRefresh(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())

	var refreshes atomic.Int32
	supabase := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshes.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "new-access",
			"refresh_token": "new-refresh",
			"expires_at":    time.Now().Add(time.Hour).Unix(),
			"user": map[string]string{
				"id":    "user-1",
				"email": "user@example.com",
			},
		})
	}))
	defer supabase.Close()

	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/auth/config":
			_ = json.NewEncoder(w).Encode(map[string]string{
				"supabase_url":             supabase.URL,
				"supabase_publishable_key": "publishable-key",
			})
		case "/protected":
			if r.Header.Get("Authorization") == "Bearer old-access" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			t.Fatalf("unexpected API request %s", r.URL.Path)
		}
	}))
	defer apiServer.Close()

	expiresAt := time.Now().Add(time.Hour).Unix()
	if err := state.Save(&state.CliState{
		APIURL: apiServer.URL,
		SupabaseSession: &state.SupabaseSession{
			AccessToken:  "old-access",
			RefreshToken: "old-refresh",
			ExpiresAt:    &expiresAt,
		},
		Organizations: map[string]state.Organization{},
	}); err != nil {
		t.Fatal(err)
	}

	const callers = 8
	start := make(chan struct{})
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := DoAuthenticated(t.Context(), apiServer.URL, http.MethodGet, "/protected", nil, nil)
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("DoAuthenticated: %v", err)
		}
	}
	if got := refreshes.Load(); got != 1 {
		t.Fatalf("refresh requests = %d, want 1", got)
	}
}

func TestDoAuthenticatedDoesNotRefreshOrTranslateForbidden(t *testing.T) {
	t.Setenv(EnvAPIKey, "")
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())

	var configRequests atomic.Int32
	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/auth/config":
			configRequests.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
		case "/protected":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"detail":"insufficient permissions"}`))
		default:
			t.Fatalf("unexpected request %s", r.URL.Path)
		}
	}))
	defer apiServer.Close()

	expiresAt := time.Now().Add(time.Hour).Unix()
	if err := state.Save(&state.CliState{
		APIURL: apiServer.URL,
		SupabaseSession: &state.SupabaseSession{
			AccessToken:  "access",
			RefreshToken: "refresh",
			ExpiresAt:    &expiresAt,
		},
		Organizations: map[string]state.Organization{},
	}); err != nil {
		t.Fatal(err)
	}

	_, err := DoAuthenticated(t.Context(), apiServer.URL, http.MethodGet, "/protected", nil, nil)
	if err == nil {
		t.Fatal("expected forbidden error")
	}
	if errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("forbidden error was translated to ErrNotLoggedIn: %v", err)
	}
	if got := configRequests.Load(); got != 0 {
		t.Fatalf("auth config requests = %d, want 0", got)
	}
}
