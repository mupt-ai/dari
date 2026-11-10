package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/mupt-ai/dari/internal/api"
)

const supabaseTimeout = 15 * time.Second

// authConfig is what api.dari.dev/v1/auth/config returns.
type authConfig struct {
	SupabaseURL            string `json:"supabase_url"`
	SupabasePublishableKey string `json:"supabase_publishable_key"`
	WebAppURL              string `json:"web_app_url"`
}

// supabaseSession mirrors the shape gotrue returns on /token exchanges.
// Extra fields from the server are ignored.
type supabaseSession struct {
	AccessToken  string       `json:"access_token"`
	RefreshToken string       `json:"refresh_token"`
	ExpiresIn    int64        `json:"expires_in"`
	ExpiresAt    int64        `json:"expires_at"`
	TokenType    string       `json:"token_type"`
	User         supabaseUser `json:"user"`
}

type supabaseUser struct {
	ID           string         `json:"id"`
	Email        string         `json:"email"`
	UserMetadata map[string]any `json:"user_metadata"`
}

// supabaseClient wraps the three gotrue REST calls we use: PKCE exchange,
// refresh, and logout. It holds the apikey header that every call needs.
type supabaseClient struct {
	url    string
	apikey string
	http   *http.Client
}

func newSupabaseClient(cfg authConfig) *supabaseClient {
	return &supabaseClient{
		url:    strings.TrimRight(cfg.SupabaseURL, "/"),
		apikey: cfg.SupabasePublishableKey,
		http:   &http.Client{Timeout: supabaseTimeout},
	}
}

// exchangeCode redeems the PKCE auth code for a session.
func (c *supabaseClient) exchangeCode(ctx context.Context, authCode, verifier string) (*supabaseSession, error) {
	body := map[string]string{"auth_code": authCode, "code_verifier": verifier}
	return c.postToken(ctx, "pkce", body)
}

// refresh exchanges a refresh_token for a new session.
func (c *supabaseClient) refresh(ctx context.Context, refreshToken string) (*supabaseSession, error) {
	body := map[string]string{"refresh_token": refreshToken}
	return c.postToken(ctx, "refresh_token", body)
}

// signOut best-effort revokes the server-side session. Ignored errors on the
// caller side (logout still clears local state).
func (c *supabaseClient) signOut(ctx context.Context, accessToken string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/auth/v1/logout?scope=local", nil)
	if err != nil {
		return err
	}
	req.Header.Set("apikey", c.apikey)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(resp.Body)
		return &api.HTTPError{Status: resp.StatusCode, Detail: strings.TrimSpace(string(raw))}
	}
	return nil
}

func (c *supabaseClient) postToken(ctx context.Context, grantType string, body any) (*supabaseSession, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/auth/v1/token?grant_type="+grantType, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("apikey", c.apikey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		detail := strings.TrimSpace(string(raw))
		var parsed struct {
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
			Message          string `json:"message"`
		}
		if err := json.Unmarshal(raw, &parsed); err == nil {
			switch {
			case parsed.ErrorDescription != "":
				detail = parsed.ErrorDescription
			case parsed.Message != "":
				detail = parsed.Message
			case parsed.Error != "":
				detail = parsed.Error
			}
		}
		return nil, &api.HTTPError{Status: resp.StatusCode, Detail: detail}
	}
	var sess supabaseSession
	if err := json.Unmarshal(raw, &sess); err != nil {
		return nil, fmt.Errorf("decode supabase session: %w", err)
	}
	if sess.AccessToken == "" || sess.RefreshToken == "" || sess.User.ID == "" {
		return nil, fmt.Errorf("supabase session missing required fields")
	}
	// Normalize expires_at: some grant types return only expires_in.
	if sess.ExpiresAt == 0 && sess.ExpiresIn > 0 {
		sess.ExpiresAt = time.Now().Unix() + sess.ExpiresIn
	}
	return &sess, nil
}

// fetchAuthConfig calls {apiURL}/v1/auth/config and returns the Supabase
// credentials the CLI uses to talk directly to gotrue.
func fetchAuthConfig(ctx context.Context, apiURL string) (authConfig, error) {
	var cfg authConfig
	err := api.New(apiURL).Do(ctx, http.MethodGet, "/v1/auth/config", nil, &cfg)
	if err != nil {
		return authConfig{}, err
	}
	if cfg.SupabaseURL == "" || cfg.SupabasePublishableKey == "" {
		return authConfig{}, fmt.Errorf("CLI auth configuration response was invalid")
	}
	return cfg, nil
}

// displayNameFromUser extracts a friendly display name from user_metadata.
func displayNameFromUser(user supabaseUser) string {
	for _, key := range []string{"full_name", "name"} {
		if raw, ok := user.UserMetadata[key]; ok {
			if s, ok := raw.(string); ok {
				trimmed := strings.TrimSpace(s)
				if trimmed != "" {
					return trimmed
				}
			}
		}
	}
	return ""
}
