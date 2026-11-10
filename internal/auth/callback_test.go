package auth

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestParseManualCallbackURL(t *testing.T) {
	got, err := ParseCallbackURL("http://127.0.0.1:12345/callback?code=abc123&state=state123")
	if err != nil {
		t.Fatalf("ParseCallbackURL: %v", err)
	}
	if got.Code != "abc123" || got.State != "state123" || got.Error != "" {
		t.Fatalf("unexpected result: %+v", got)
	}
}

func TestParseManualCallbackRawCodeRejected(t *testing.T) {
	if _, err := ParseCallbackURL(" abc123 \n"); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseManualCallbackErrorURL(t *testing.T) {
	got, err := ParseCallbackURL("http://127.0.0.1:12345/callback?error_description=denied")
	if err != nil {
		t.Fatalf("ParseCallbackURL: %v", err)
	}
	if got.Error != "denied" || got.Code != "" {
		t.Fatalf("unexpected result: %+v", got)
	}
}

func TestParseManualCallbackURLWithoutCode(t *testing.T) {
	if _, err := ParseCallbackURL("http://127.0.0.1:12345/callback"); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseManualCallbackURLWithoutState(t *testing.T) {
	if _, err := ParseCallbackURL("http://127.0.0.1:12345/callback?code=abc123"); err == nil {
		t.Fatal("expected error")
	}
}

func TestBuildWebLoginURL(t *testing.T) {
	got, err := buildWebLoginURL(
		"https://app.dari.dev/",
		"http://127.0.0.1:12345/callback",
		"state123",
		"challenge123",
	)
	if err != nil {
		t.Fatalf("buildWebLoginURL: %v", err)
	}
	want := "https://app.dari.dev/login?cli_callback=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback&cli_code_challenge=challenge123&cli_state=state123"
	if got != want {
		t.Fatalf("unexpected URL:\n got: %s\nwant: %s", got, want)
	}
}

func TestCallbackServerServesTheCompletionPage(t *testing.T) {
	server, err := startCallbackServer()
	if err != nil {
		t.Fatalf("startCallbackServer: %v", err)
	}
	defer server.Close()

	resp, err := http.Get(server.RedirectURL + "?code=abc&state=state123")
	if err != nil {
		t.Fatalf("GET callback: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read callback page: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("callback status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Fatalf("callback content type = %q, want text/html", got)
	}
	if !strings.Contains(string(body), "Signed in to Dari") {
		t.Fatalf("callback page is missing its heading:\n%s", body)
	}

	select {
	case res := <-server.result:
		if res.Code != "abc" || res.State != "state123" {
			t.Fatalf("unexpected callback result: %+v", res)
		}
	default:
		t.Fatal("callback did not deliver a result")
	}
}

func TestCallbackPageEscapesTheErrorText(t *testing.T) {
	page := callbackPage{title: "Sign-in didn't finish", message: `<img src=x onerror="alert(1)">`, failed: true}.render()
	if strings.Contains(page, "<img") {
		t.Fatalf("callback page did not escape the error:\n%s", page)
	}
	if !strings.Contains(page, "&lt;img") {
		t.Fatalf("callback page is missing the escaped error:\n%s", page)
	}
}
