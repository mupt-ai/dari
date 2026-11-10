package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

// pkcePair is an S256 PKCE verifier/challenge pair.
type pkcePair struct {
	Verifier  string
	Challenge string
}

// newPKCEPair generates a PKCE verifier per RFC 7636 (43 chars of URL-safe
// base64) along with the SHA-256 S256 challenge. The Supabase auth server
// validates code_verifier against code_challenge on the /token?grant_type=pkce
// exchange.
func newPKCEPair() (*pkcePair, error) {
	// 32 random bytes → 43 base64url chars (unpadded), inside the 43-128
	// range required by the spec.
	verifier, err := randomURLToken(urlTokenEntropyBytes)
	if err != nil {
		return nil, fmt.Errorf("pkce entropy: %w", err)
	}
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	return &pkcePair{Verifier: verifier, Challenge: challenge}, nil
}

func randomURLToken(byteCount int) (string, error) {
	buf := make([]byte, byteCount)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("auth entropy: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
