package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type apiKeyCreateRequest struct {
	Label   string `json:"label"`
	KeyType string `json:"key_type"`
}

func TestAPIKeysCreateType(t *testing.T) {
	tests := []struct {
		name     string
		typeArgs []string
		want     string
	}{
		{
			name: "default management type",
			want: "management",
		},
		{
			name:     "routing type",
			typeArgs: []string{"--type", "routing"},
			want:     "routing",
		},
		{
			name:     "normalizes type",
			typeArgs: []string{"--type", " Management "},
			want:     "management",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := runAPIKeysCreate(t, tt.typeArgs)
			if got.Label != "Router client" {
				t.Fatalf("label = %q", got.Label)
			}
			if got.KeyType != tt.want {
				t.Fatalf("key_type = %q, want %q", got.KeyType, tt.want)
			}
		})
	}
}

func TestNormalizeAPIKeyTypeRejectsUnsupportedType(t *testing.T) {
	if _, err := normalizeAPIKeyType("platform"); err == nil {
		t.Fatal("normalizeAPIKeyType accepted unsupported type")
	}
}

func runAPIKeysCreate(t *testing.T, typeArgs []string) apiKeyCreateRequest {
	t.Helper()

	var got apiKeyCreateRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/v1/organizations/current/api-keys" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"id":       "key_123",
			"label":    got.Label,
			"key_type": got.KeyType,
		}); err != nil {
			t.Fatalf("encode response: %v", err)
		}
	}))
	defer srv.Close()

	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	args := []string{"--api-url", srv.URL, "api-keys", "create", "--name", "Router client"}
	args = append(args, typeArgs...)
	cmd.SetArgs(args)

	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatal(err)
	}
	return got
}

func captureStdout(t *testing.T, fn func() error) error {
	t.Helper()
	_, err := captureStdoutBytes(t, fn)
	return err
}
