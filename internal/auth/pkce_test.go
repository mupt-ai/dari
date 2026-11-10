package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"regexp"
	"testing"
)

func TestPKCEPairShape(t *testing.T) {
	pair, err := newPKCEPair()
	if err != nil {
		t.Fatalf("newPKCEPair: %v", err)
	}
	// RFC 7636: verifier is 43-128 chars, URL-safe base64 charset.
	if len(pair.Verifier) < 43 || len(pair.Verifier) > 128 {
		t.Errorf("verifier length %d out of range", len(pair.Verifier))
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(pair.Verifier) {
		t.Errorf("verifier charset: %q", pair.Verifier)
	}
	// Challenge must be S256(verifier) base64url-encoded.
	sum := sha256.Sum256([]byte(pair.Verifier))
	want := base64.RawURLEncoding.EncodeToString(sum[:])
	if pair.Challenge != want {
		t.Errorf("challenge mismatch:\n got %q\nwant %q", pair.Challenge, want)
	}
}

func TestPKCEPairUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 16; i++ {
		p, err := newPKCEPair()
		if err != nil {
			t.Fatal(err)
		}
		if seen[p.Verifier] {
			t.Fatalf("verifier collision: %s", p.Verifier)
		}
		seen[p.Verifier] = true
	}
}
