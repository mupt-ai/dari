package cli

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestResetExpiryAndResult(t *testing.T) {
	if got := resetExpiry(subscriptionReset{ExpiresAt: stringPtr("2026-11-30T19:59:24.159131Z")}); got != " · Expires Nov 30" {
		t.Errorf("expiry = %q", got)
	}
	if got := resetExpiry(subscriptionReset{}); got != "" {
		t.Errorf("no expiry = %q", got)
	}
	if got := resetResultText("nothing_to_reset"); !strings.Contains(got, "kept") {
		t.Errorf("nothing_to_reset = %q", got)
	}
}

func stringPtr(s string) *string { return &s }

// A reset with no end date decodes and shows without an expiry.
func TestResetWithoutExpiryDecodes(t *testing.T) {
	var listed struct {
		Resets []subscriptionReset `json:"resets"`
	}
	if err := json.Unmarshal([]byte(`{"resets":[{"id":"r","label":"Full reset","expires_at":null,"usable":true}]}`), &listed); err != nil {
		t.Fatal(err)
	}
	if got := resetExpiry(listed.Resets[0]); got != "" {
		t.Fatalf("expiry = %q", got)
	}
}
