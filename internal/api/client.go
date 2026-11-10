// Package api is a thin JSON HTTP client for the Dari management API.
// Authentication + refresh orchestration lives in internal/auth; this
// package just knows how to make a request and surface structured errors.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	DefaultAPIURL    = "https://api.dari.dev"
	DefaultTimeout   = 15 * time.Second
	userAgentDefault = "dari-cli-go"
)

// HTTPError represents a non-2xx response from the API. Callers (e.g. the
// auth refresh-and-retry path) branch on Status.
type HTTPError struct {
	Status int
	Detail string
}

func (e *HTTPError) Error() string { return e.Detail }

// NetworkError wraps transport/timeout failures.
type NetworkError struct {
	Err error
}

func (e *NetworkError) Error() string { return e.Err.Error() }
func (e *NetworkError) Unwrap() error { return e.Err }

// Client is a configured HTTP client targeting a single Dari API base URL.
type Client struct {
	BaseURL    string
	HTTP       *http.Client
	UserAgent  string
	AuthHeader string // e.g. "Bearer <token>"; empty for unauthenticated calls
}

// New returns a client with sensible defaults. baseURL may be empty, in which
// case DefaultAPIURL is used. The returned client is safe for reuse.
func New(baseURL string) *Client {
	if baseURL == "" {
		baseURL = DefaultAPIURL
	}
	return &Client{
		BaseURL:   NormalizeURL(baseURL),
		HTTP:      &http.Client{Timeout: DefaultTimeout},
		UserAgent: userAgentDefault,
	}
}

// WithBearer returns a shallow copy with the Authorization header set.
func (c *Client) WithBearer(token string) *Client {
	out := *c
	out.AuthHeader = "Bearer " + token
	return &out
}

// Do sends a request with an optional JSON body and decodes the response into
// out (pass nil to discard). Returns *HTTPError on non-2xx and *NetworkError
// on transport failures.
func (c *Client) Do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request body: %w", err)
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.AuthHeader != "" {
		req.Header.Set("Authorization", c.AuthHeader)
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return &NetworkError{Err: err}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return &NetworkError{Err: err}
	}

	if resp.StatusCode >= 400 {
		return &HTTPError{Status: resp.StatusCode, Detail: extractErrorDetail(raw, resp.Status)}
	}

	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

// NormalizeURL trims whitespace and a trailing slash from an API URL.
func NormalizeURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimRight(trimmed, "/")
	if trimmed == "" {
		return strings.TrimSpace(raw)
	}
	return trimmed
}

// URLsMatch reports whether two API URLs refer to the same host, ignoring
// trailing slashes and surrounding whitespace.
func URLsMatch(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return NormalizeURL(a) == NormalizeURL(b)
}

// AsHTTPError returns the wrapped *HTTPError if err is one, else nil.
func AsHTTPError(err error) *HTTPError {
	var he *HTTPError
	if errors.As(err, &he) {
		return he
	}
	return nil
}

// HumanError unwraps an *HTTPError into a plain error carrying only the
// server-supplied detail (trimmed). Non-HTTPError errors are returned
// unchanged, and nil stays nil. Callers that want to special-case 401/403
// should branch on AsHTTPError(err).Status before calling this.
func HumanError(err error) error {
	if err == nil {
		return nil
	}
	if he := AsHTTPError(err); he != nil {
		return errors.New(strings.TrimSpace(he.Detail))
	}
	return err
}

func extractErrorDetail(raw []byte, fallback string) string {
	if len(raw) == 0 {
		return fallback
	}
	var payload struct {
		Detail any `json:"detail"`
	}
	if err := json.Unmarshal(raw, &payload); err == nil {
		if s, ok := payload.Detail.(string); ok && s != "" {
			return s
		}
		if payload.Detail != nil {
			if data, err := json.Marshal(payload.Detail); err == nil {
				return string(data)
			}
		}
	}
	// Fall back to the raw body when it's short and plausibly a message.
	if len(raw) < 512 {
		return strings.TrimSpace(string(raw))
	}
	return fallback
}
