// Package auth implements Dari's browser login, session refresh, and
// authenticated API request flow. It owns the web-assisted Supabase PKCE login,
// refresh/logout calls, and the local OAuth callback server; the HTTP client
// itself lives in internal/api.
package auth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/state"
)

const (
	loginTimeout         = 10 * time.Minute
	sessionRefreshLeeway = 60 * time.Second

	// EnvAPIKey is a bearer token that bypasses `dari auth login` entirely.
	// Commands that support headless auth use it in place of the cached
	// Supabase JWT / managed org key.
	EnvAPIKey = "DARI_API_KEY"

	urlTokenEntropyBytes = 32

	// EnvOrgID names the organization for commands that build paths like
	// /v1/organizations/{id}/... while running headless with EnvAPIKey.
	EnvOrgID = "DARI_ORG_ID"
)

// Errors returned by this package are intentionally simple: callers print
// err.Error() verbatim to stderr. Use errors.Is to check auth-specific cases.
var (
	ErrNotLoggedIn    = errors.New("no CLI login is available for this API URL. Run `dari auth login` first, or set DARI_API_KEY")
	ErrNoCurrentOrg   = errors.New("no current organization is selected. Run `dari org switch <org>`, or set DARI_ORG_ID")
	ErrNeedsUserLogin = errors.New("this command requires `dari auth login`; DARI_API_KEY cannot be used here")
)

// EnvAPIKeyValue returns the DARI_API_KEY env var, trimmed. Empty means unset.
func EnvAPIKeyValue() string {
	return strings.TrimSpace(os.Getenv(EnvAPIKey))
}

// EnvOrgIDValue returns the DARI_ORG_ID env var, trimmed. Empty means unset.
func EnvOrgIDValue() string {
	return strings.TrimSpace(os.Getenv(EnvOrgID))
}

// LoginOptions customizes the interactive browser login flow.
type LoginOptions struct {
	Stdin io.Reader
	// Wait shows the browser login page and blocks until the login callback
	// arrives. When nil, LoginWithOptions prints plain text to stderr and reads
	// a pasted callback URL from Stdin.
	Wait WaitFunc
}

// WaitFunc renders the browser login wait. opened reports whether a browser
// was launched. await delivers the callback from the local listener; a pasted
// callback URL parsed with ParseCallbackURL may be returned instead.
type WaitFunc func(ctx context.Context, loginURL string, opened bool, await func(context.Context) (CallbackResult, error)) (CallbackResult, error)

// Status is what `dari auth status` prints.
type Status struct {
	APIURL      string              `json:"api_url"`
	Email       string              `json:"email"`
	CurrentOrg  *state.Organization `json:"current_org"`
	LoggedIn    bool                `json:"logged_in"`
	SessionMode string              `json:"session_mode"`
}

// LoginWithOptions runs the full browser login flow: web-assisted Supabase
// PKCE login + /v1/me/bootstrap + /v1/organizations/{id}/managed-cli-key/ensure.
// The resulting state is persisted to disk.
func LoginWithOptions(ctx context.Context, apiURL string, opts LoginOptions) (*state.CliState, error) {
	if EnvAPIKeyValue() != "" {
		return nil, errors.New("DARI_API_KEY is set; `dari auth login` is not needed (unset the env var to use a browser login)")
	}
	apiURL = api.NormalizeURL(apiURL)

	cfg, err := fetchAuthConfig(ctx, apiURL)
	if err != nil {
		return nil, fmt.Errorf("fetch CLI auth configuration: %w", err)
	}
	if strings.TrimSpace(cfg.WebAppURL) == "" {
		return nil, errors.New("CLI browser login requires DARI_WEB_APP_URL to be configured on the API")
	}

	cliState, err := randomURLToken(urlTokenEntropyBytes)
	if err != nil {
		return nil, err
	}
	pkce, err := newPKCEPair()
	if err != nil {
		return nil, err
	}
	server, err := startCallbackServer()
	if err != nil {
		return nil, err
	}
	defer server.Close()

	loginURL, err := buildWebLoginURL(cfg.WebAppURL, server.RedirectURL, cliState, pkce.Challenge)
	if err != nil {
		return nil, err
	}
	opened := OpenBrowser(loginURL)
	var cb CallbackResult
	if opts.Wait != nil {
		cb, err = opts.Wait(ctx, loginURL, opened, func(waitCtx context.Context) (CallbackResult, error) {
			return server.Wait(waitCtx, loginTimeout)
		})
	} else {
		if opened {
			fmt.Fprintf(os.Stderr, "Waiting for browser login. If it doesn't complete automatically, open this URL:\n  %s\n\nAfter signing in, paste the localhost callback URL below.\n", loginURL)
		} else {
			fmt.Fprintf(os.Stderr, "Open this URL in a browser to continue login:\n  %s\n\nAfter signing in, paste the localhost callback URL below.\n", loginURL)
		}
		cb, err = server.WaitOrInput(ctx, opts.Stdin, loginTimeout)
	}
	if err != nil {
		return nil, err
	}
	if cb.Error != "" {
		return nil, fmt.Errorf("browser login failed: %s", cb.Error)
	}

	if cb.State != cliState {
		return nil, errors.New("browser login returned an invalid state")
	}

	sess, err := newSupabaseClient(cfg).exchangeCode(ctx, cb.Code, pkce.Verifier)
	if err != nil {
		return nil, fmt.Errorf("exchange Supabase auth code: %w", err)
	}

	s := &state.CliState{
		APIURL:          apiURL,
		SupabaseSession: sessionToStored(sess),
		Organizations:   map[string]state.Organization{},
	}

	if err := bootstrapAndSelectOrg(ctx, s, apiURL, ""); err != nil {
		return nil, err
	}
	if err := state.Save(s); err != nil {
		return nil, err
	}
	return s, nil
}

// Logout best-effort revokes the Supabase session and clears local state.
func Logout(ctx context.Context, apiURL string) error {
	apiURL = api.NormalizeURL(apiURL)
	var accessToken string
	if err := state.Update(func(s *state.CliState) error {
		if !api.URLsMatch(s.APIURL, apiURL) || s.SupabaseSession == nil {
			return nil
		}
		accessToken = s.SupabaseSession.AccessToken
		*s = state.CliState{Organizations: map[string]state.Organization{}}
		return nil
	}); err != nil {
		return err
	}
	if accessToken != "" {
		if cfg, err := fetchAuthConfig(ctx, apiURL); err == nil {
			_ = newSupabaseClient(cfg).signOut(ctx, accessToken)
		}
	}
	return nil
}

// CurrentStatus returns the cached auth status without making network calls.
func CurrentStatus(apiURL string) (Status, error) {
	apiURL = api.NormalizeURL(apiURL)
	if EnvAPIKeyValue() != "" {
		status := Status{
			APIURL:      api.NormalizeURL(apiURL),
			LoggedIn:    true,
			SessionMode: "env_key",
		}
		if id := EnvOrgIDValue(); id != "" {
			status.CurrentOrg = &state.Organization{ID: id}
		}
		return status, nil
	}
	s, err := state.Load()
	if err != nil {
		return Status{}, err
	}
	if !api.URLsMatch(s.APIURL, apiURL) {
		return Status{}, nil
	}
	org := s.CurrentOrg()

	hasFreshJWT := s.SupabaseSession != nil && !storedSessionNeedsRefresh(s.SupabaseSession)
	hasCachedKey := org != nil && org.APIKey != ""

	mode := ""
	switch {
	case hasFreshJWT:
		mode = "jwt"
	case hasCachedKey:
		mode = "api_key"
	}
	if mode == "" {
		return Status{}, nil
	}
	email := ""
	if s.SupabaseSession != nil {
		email = s.SupabaseSession.Email
	}
	return Status{
		APIURL:      s.APIURL,
		Email:       email,
		CurrentOrg:  org,
		LoggedIn:    true,
		SessionMode: mode,
	}, nil
}

// DoAuthenticated issues an API request using the cached JWT, refreshing it
// on demand (proactively if expired, or reactively on a 401). Refresh is
// serialized across CLI processes so a rotated refresh token cannot be reused.
//
// If DARI_API_KEY is set it takes precedence: the key is used as the bearer,
// the JWT refresh dance is skipped entirely, and no state is written.
func DoAuthenticated(ctx context.Context, apiURL, method, path string, body, out any) (*state.CliState, error) {
	apiURL = api.NormalizeURL(apiURL)
	if key := EnvAPIKeyValue(); key != "" {
		err := api.New(apiURL).WithBearer(key).Do(ctx, method, path, body, out)
		return nil, translateAuthError(err)
	}
	s, err := state.Load()
	if err != nil {
		return nil, err
	}
	if !api.URLsMatch(s.APIURL, apiURL) || s.SupabaseSession == nil {
		return nil, ErrNotLoggedIn
	}

	refreshedBeforeRequest := false
	if storedSessionNeedsRefresh(s.SupabaseSession) {
		s, err = refreshStoredSession(ctx, apiURL, "")
		if err != nil {
			return nil, err
		}
		refreshedBeforeRequest = true
	}

	accessToken := s.SupabaseSession.AccessToken
	client := api.New(apiURL).WithBearer(accessToken)
	err = client.Do(ctx, method, path, body, out)
	if err == nil {
		return s, nil
	}
	if he := api.AsHTTPError(err); he != nil && he.Status == 401 && !refreshedBeforeRequest {
		s, err = refreshStoredSession(ctx, apiURL, accessToken)
		if err != nil {
			return nil, err
		}
		client = api.New(apiURL).WithBearer(s.SupabaseSession.AccessToken)
		err = client.Do(ctx, method, path, body, out)
	}
	return s, translateAuthError(err)
}

// refreshStoredSession reloads state while holding the cross-process lock.
// If another process already replaced rejectedAccessToken, its session is
// reused rather than rotating the new refresh token again.
func refreshStoredSession(ctx context.Context, apiURL, rejectedAccessToken string) (*state.CliState, error) {
	var refreshed *state.CliState
	err := state.Update(func(s *state.CliState) error {
		if !api.URLsMatch(s.APIURL, apiURL) || s.SupabaseSession == nil {
			return ErrNotLoggedIn
		}
		if rejectedAccessToken != "" && s.SupabaseSession.AccessToken != rejectedAccessToken {
			refreshed = s
			return nil
		}
		if rejectedAccessToken == "" && !storedSessionNeedsRefresh(s.SupabaseSession) {
			refreshed = s
			return nil
		}
		if err := refresh(ctx, s, apiURL); err != nil {
			return err
		}
		refreshed = s
		return nil
	})
	return refreshed, err
}

// refresh exchanges the stored refresh_token for a new session and mutates s
// in place. It does not persist; the caller is responsible for saving.
func refresh(ctx context.Context, s *state.CliState, apiURL string) error {
	if s.SupabaseSession == nil {
		return ErrNotLoggedIn
	}
	cfg, err := fetchAuthConfig(ctx, apiURL)
	if err != nil {
		return fmt.Errorf("fetch CLI auth configuration: %w", err)
	}
	sess, err := newSupabaseClient(cfg).refresh(ctx, s.SupabaseSession.RefreshToken)
	if err != nil {
		return fmt.Errorf("refresh supabase session: %w", err)
	}
	s.APIURL = apiURL
	s.SupabaseSession = sessionToStored(sess)
	return nil
}

func storedSessionNeedsRefresh(s *state.SupabaseSession) bool {
	if s == nil || s.ExpiresAt == nil {
		return true
	}
	return *s.ExpiresAt <= time.Now().Unix()+int64(sessionRefreshLeeway.Seconds())
}

func sessionToStored(sess *supabaseSession) *state.SupabaseSession {
	expires := sess.ExpiresAt
	return &state.SupabaseSession{
		AccessToken:  sess.AccessToken,
		RefreshToken: sess.RefreshToken,
		ExpiresAt:    &expires,
		UserID:       sess.User.ID,
		Email:        sess.User.Email,
		DisplayName:  displayNameFromUser(sess.User),
	}
}

func translateAuthError(err error) error {
	if he := api.AsHTTPError(err); he != nil && he.Status == 401 {
		return fmt.Errorf("%w: %s", ErrNotLoggedIn, strings.TrimSpace(he.Detail))
	}
	return api.HumanError(err)
}

func buildWebLoginURL(webAppURL, callbackURL, state, codeChallenge string) (string, error) {
	u, err := url.Parse(strings.TrimRight(webAppURL, "/") + "/login")
	if err != nil {
		return "", fmt.Errorf("parse web app URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("web app URL must be http(s)")
	}
	q := u.Query()
	q.Set("cli_callback", callbackURL)
	q.Set("cli_state", state)
	q.Set("cli_code_challenge", codeChallenge)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// OrgKeyClient returns an api.Client authenticated with the cached managed
// CLI API key (the `dari_...` bearer) for the current organization. Used by
// commands (router, credentials, api-keys) that the server authenticates
// via the org API key rather than the user JWT.
//
// If DARI_API_KEY is set it takes precedence, skipping the state/login cache.
func OrgKeyClient(apiURL string) (*api.Client, error) {
	apiURL = api.NormalizeURL(apiURL)
	if key := EnvAPIKeyValue(); key != "" {
		return api.New(apiURL).WithBearer(key), nil
	}
	s, err := state.Load()
	if err != nil {
		return nil, err
	}
	if !api.URLsMatch(s.APIURL, apiURL) {
		return nil, ErrNotLoggedIn
	}
	org := s.CurrentOrg()
	if org == nil {
		return nil, ErrNoCurrentOrg
	}
	if org.APIKey == "" {
		return nil, fmt.Errorf("no cached API key for current org; run `dari org switch %s` to refresh", org.Slug)
	}
	return api.New(apiURL).WithBearer(org.APIKey), nil
}
