package cli

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/state"
)

const testLoginURL = "https://app.dari.dev/login?cli_callback=http%3A%2F%2F127.0.0.1%3A52141%2Fcallback&cli_code_challenge=challenge123&cli_state=state123"

func TestLoginPageShowsTheBrowserURLAndPasteFallback(t *testing.T) {
	page := strings.Join(loginPageLines(testLoginURL, true, "", nil, "⠸", 80), "\n")
	for _, want := range []string{
		"Sign in to Dari",
		"Opened your browser. Finish signing in there.",
		testLoginURL,
		"Waiting for your browser…",
		"paste the callback URL (remote machines)",
		"enter submit · ctrl+c cancel",
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("login page is missing %q:\n%s", want, page)
		}
	}
}

func TestLoginPageAsksForTheURLWhenTheBrowserDidNotOpen(t *testing.T) {
	page := strings.Join(loginPageLines(testLoginURL, false, "", nil, "⠸", 80), "\n")
	if !strings.Contains(page, "Open this URL in your browser to sign in:") {
		t.Fatalf("login page is missing the manual URL instruction:\n%s", page)
	}
	if strings.Contains(page, "Opened your browser") {
		t.Fatalf("login page claims the browser opened:\n%s", page)
	}
}

func TestLoginPageShowsPastedURLAndInputError(t *testing.T) {
	page := strings.Join(loginPageLines(testLoginURL, true, "http://127.0.0.1:1/callback", errors.New("callback URL did not include state"), "⠸", 80), "\n")
	if !strings.Contains(page, ansiCyan+"http://127.0.0.1:1/callback"+ansiReset) {
		t.Fatalf("login page hides the pasted URL:\n%s", page)
	}
	if !strings.Contains(page, "callback URL did not include state") {
		t.Fatalf("login page hides the input error:\n%s", page)
	}
}

func TestLoginPageFitsTheTerminalWidth(t *testing.T) {
	// Fixed prose lines set the floor; the existing onboarding pages share it.
	for _, width := range []int{60, 80, 120} {
		for _, lines := range [][]string{
			loginPageLines(testLoginURL, true, "", nil, "⠸", width),
			loginPageLines(testLoginURL, false, "http://127.0.0.1:52141/callback?code=abc&state=state123", errors.New("callback URL did not include state"), "⠸", width),
		} {
			for _, line := range append(pageHeader(width, "Sign in to the Dari CLI"), lines...) {
				if got := ansiVisibleWidth(line); got > width {
					t.Fatalf("width %d: line is %d cells: %q", width, got, line)
				}
			}
		}
	}
}

func TestWrapURLBreaksBetweenQueryParameters(t *testing.T) {
	url := "https://a.dev/x?a=1&cli_code_challenge=defghijklmnopqrstuvwxyz&cli_state=ghi"
	pieces := wrapURL(url, 45)
	want := []string{"https://a.dev/x?a=1", "&cli_code_challenge=defghijklmnopqrstuvwxyz", "&cli_state=ghi"}
	if strings.Join(pieces, "") != url {
		t.Fatalf("wrapURL lost characters: %q", pieces)
	}
	if len(pieces) != len(want) {
		t.Fatalf("wrapURL made %d pieces, want %d: %q", len(pieces), len(want), pieces)
	}
	for index, piece := range pieces {
		if len(piece) > 45 {
			t.Fatalf("piece %q exceeds the width", piece)
		}
		if piece != want[index] {
			t.Fatalf("piece %d = %q, want %q", index, piece, want[index])
		}
	}
	// A parameter longer than the width still splits rather than overflowing.
	for _, piece := range wrapURL(strings.Repeat("a", 100), 40) {
		if len(piece) > 40 {
			t.Fatalf("long parameter overflowed: %q", piece)
		}
	}
}

func TestInputDisplayKeepsThePlaceholderWhenTheWidthIsUnknown(t *testing.T) {
	want := ansiDim + "paste the callback URL" + ansiReset
	if got := inputDisplay("", 0, "paste the callback URL"); got != want {
		t.Fatalf("inputDisplay with unknown width = %q, want %q", got, want)
	}
}

// The plain fallback login never opens the page, so `dari auth login` on a
// terminal stdout must still say who signed in.
func TestReportLoginNamesTheAccountAndOrganization(t *testing.T) {
	var stderr bytes.Buffer
	reportLogin(&stderr, &state.CliState{
		SupabaseSession: &state.SupabaseSession{Email: "avyay@example.com"},
		CurrentOrgID:    "org-1",
		Organizations:   map[string]state.Organization{"org-1": {ID: "org-1", Name: "Dari"}},
	})
	want := "Signed in as avyay@example.com\nOrganization: Dari\n"
	if got := stderr.String(); got != want {
		t.Fatalf("reportLogin wrote %q, want %q", got, want)
	}
}

func TestClipText(t *testing.T) {
	cases := []struct {
		text  string
		width int
		want  string
	}{
		{"dari", 8, "dari"},
		{"dari", 4, "dari"},
		{"dari", 3, "da…"},
		{"dari", 1, "…"},
		{"dari", 0, ""},
	}
	for _, c := range cases {
		if got := clipText(c.text, c.width); got != c.want {
			t.Fatalf("clipText(%q, %d) = %q, want %q", c.text, c.width, got, c.want)
		}
	}
}
