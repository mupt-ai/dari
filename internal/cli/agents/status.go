package agents

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"unicode"
)

// Status is the common display contract. Remaining counts turns after the
// current response; the display includes the current turn. Pinned marks a
// session-pinned decision, which replaces the lease. RequestID is the last
// response's routing request, which opens its conversation in Activity.
type Status struct {
	Model     string `json:"selected_model"`
	Thinking  string `json:"reasoning_effort"`
	Remaining *int   `json:"lease_turns_remaining"`
	Pinned    bool   `json:"session_pinned"`
	RequestID string `json:"request_id"`
}

// Requests through a gateway (NoActivityLinkEnv, or GatewayURLEnv from
// launches before it) never reach the Activity dashboard, so they get no link.
const dashboardBaseURL = "https://app.dari.dev"

func (s Status) String() string {
	model := statusLabel(s.Model)
	if model == "" {
		return ""
	}
	parts := []string{model}
	if thinking := statusLabel(s.Thinking); thinking != "" && thinking != "off" {
		parts = append(parts, thinking)
	}
	if s.Pinned {
		parts = append(parts, "pinned")
	} else if s.Remaining != nil && *s.Remaining >= 0 && *s.Remaining < 1_000_000 {
		turns := *s.Remaining + 1
		unit := "turns"
		if turns == 1 {
			unit = "turn"
		}
		parts = append(parts, fmt.Sprintf("lease %d %s left", turns, unit))
	}
	if requestID := statusLabel(s.RequestID); requestID != "" && os.Getenv(NoActivityLinkEnv) == "" && os.Getenv(GatewayURLEnv) == "" {
		parts = append(parts, dashboardBaseURL+"/activity/conversations/"+url.PathEscape(requestID))
	}
	return strings.Join(parts, " · ")
}

func statusLabel(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, value)
	return strings.TrimSpace(value)
}

// StatusFromHeaders reads the routing headers Dari sets on every response.
func StatusFromHeaders(headers http.Header) Status {
	status := Status{
		Model:     headers.Get("x-dari-selected-model"),
		Thinking:  headers.Get("x-dari-thinking-level"),
		Pinned:    headers.Get("x-dari-session-pinned") == "true",
		RequestID: headers.Get("x-request-id"),
	}
	if remaining, err := strconv.Atoi(headers.Get("x-dari-lease-turns-remaining")); err == nil {
		status.Remaining = &remaining
	}
	return status
}

// StatusExecutable is the Dari binary, whose hidden agent-status command
// renders the status line for agents that shell out to it.
func StatusExecutable() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locate Dari status renderer: %w", err)
	}
	return path, nil
}

// StatusEnvironment tells an in-agent integration how to render status. The
// TypeScript integrations read these rather than having values spliced in.
func StatusEnvironment() (map[string]string, error) {
	executable, err := StatusExecutable()
	if err != nil {
		return nil, err
	}
	return map[string]string{
		"DARI_STATUS_EXECUTABLE": executable,
	}, nil
}

func ShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}
