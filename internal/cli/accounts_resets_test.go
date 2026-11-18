package cli

import (
	"strings"
	"testing"
)

func TestResetExpiryAndResult(t *testing.T) {
	if got := resetExpiry(subscriptionReset{ExpiresAt: "2026-11-30T19:59:24.159131Z"}); got != " · Expires Nov 30" {
		t.Errorf("expiry = %q", got)
	}
	if got := resetExpiry(subscriptionReset{}); got != "" {
		t.Errorf("no expiry = %q", got)
	}
	if got := resetResultText("nothing_to_reset"); !strings.Contains(got, "kept") {
		t.Errorf("nothing_to_reset = %q", got)
	}
}
