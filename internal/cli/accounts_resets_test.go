package cli

import (
	"errors"
	"strings"
	"testing"
)

func TestSubscriptionResetLines(t *testing.T) {
	plain := func(lines []string) string {
		text := strings.Join(lines, "\n")
		for _, code := range []string{ansiGray, ansiReset} {
			text = strings.ReplaceAll(text, code, "")
		}
		return text
	}
	got := plain(subscriptionResetLines([]subscriptionReset{
		{ID: "a", Label: "Full reset", ExpiresAt: "2026-11-30T19:59:24.159131Z", Usable: true},
		{ID: "b", Label: "Monthly reset", Usable: false},
	}, nil))
	for _, want := range []string{"Banked resets · 2", "› Full reset · Expires Nov 30", "› Monthly reset · Not usable yet"} {
		if !strings.Contains(got, want) {
			t.Errorf("lines missing %q:\n%s", want, got)
		}
	}
	if got := plain(subscriptionResetLines(nil, nil)); !strings.Contains(got, "No banked resets") {
		t.Errorf("empty lines = %q", got)
	}
	if got := plain(subscriptionResetLines(nil, errors.New("boom"))); !strings.Contains(got, "Couldn't read banked resets: boom") {
		t.Errorf("error lines = %q", got)
	}
	if got := resetResultText("nothing_to_reset"); !strings.Contains(got, "kept") {
		t.Errorf("nothing_to_reset = %q", got)
	}
}
