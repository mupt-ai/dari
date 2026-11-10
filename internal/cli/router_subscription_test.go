package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func routerSubscriptionTestServer(t *testing.T, body *map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/organizations/current/routers/rtr_123":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":             "rtr_123",
				"name":           "Production",
				"enabled_models": []string{"openai/gpt-5.6-sol", "anthropic/claude-fable-5"},
			})
		case "GET /v1/organizations/current/routers/model-catalog":
			_, _ = w.Write([]byte(`{"groups":[]}`))
		case "POST /v1/organizations/current/routers", "PUT /v1/organizations/current/routers/rtr_123":
			raw, _ := io.ReadAll(r.Body)
			*body = nil
			if err := json.Unmarshal(raw, body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_123"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestRouterCreateSendsSubscriptionFlags(t *testing.T) {
	var body map[string]any
	srv := routerSubscriptionTestServer(t, &body)
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"--api-url", srv.URL, "router", "create", "Subscriptions",
		"--model", "openai/gpt-5.6-sol,anthropic/claude-fable-5",
		"--managed-key", "openai,anthropic",
		"--subscription", "OpenAI", "--subscription", "anthropic",
		"--api-fallback", "openai/gpt-5.6-sol",
	})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router create: %v", err)
	}
	if got, want := body["subscription_providers"], []any{"openai", "anthropic"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("subscription_providers = %#v, want %#v", got, want)
	}
	if got, want := body["subscription_api_fallback_models"], []any{"openai/gpt-5.6-sol"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("subscription_api_fallback_models = %#v, want %#v", got, want)
	}
}

func TestRouterUpdateSubscriptionFlagsKeepOrClear(t *testing.T) {
	for _, tc := range []struct {
		name      string
		args      []string
		providers any
		fallbacks any
	}{
		{name: "omitted keeps both", args: []string{"--name", "Renamed"}},
		{name: "replaces providers", args: []string{"--subscription", "anthropic"}, providers: []any{"anthropic"}},
		{name: "takes a Muse Code subscription", args: []string{"--subscription", "Meta"}, providers: []any{"meta"}},
		{name: "empty clears", args: []string{"--subscription", "", "--api-fallback", ""}, providers: []any{}, fallbacks: []any{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			srv := routerSubscriptionTestServer(t, &body)
			useTestAPIKey(t)

			cmd := newRootCmd("dev")
			cmd.SetArgs(append([]string{"--api-url", srv.URL, "router", "update", "rtr_123"}, tc.args...))
			if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
				t.Fatalf("dari router update: %v", err)
			}
			if got := body["subscription_providers"]; !reflect.DeepEqual(got, tc.providers) {
				t.Fatalf("subscription_providers = %#v, want %#v", got, tc.providers)
			}
			if got := body["subscription_api_fallback_models"]; !reflect.DeepEqual(got, tc.fallbacks) {
				t.Fatalf("subscription_api_fallback_models = %#v, want %#v", got, tc.fallbacks)
			}
		})
	}
}

func TestRouterSubscriptionFlagRejectsProvidersWithoutSubscriptions(t *testing.T) {
	useTestAPIKey(t)
	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"router", "create", "Bad", "--model", "xai/grok-4.7", "--managed-key", "xai", "--subscription", "xai"})
	cmd.SetErr(io.Discard)
	err := captureStdout(t, func() error { return cmd.Execute() })
	if err == nil || !strings.Contains(err.Error(), "openai, anthropic, or meta") {
		t.Fatalf("err = %v, want a subscription provider error", err)
	}
}

func TestRouterCreateFromManifestSendsSubscriptionFields(t *testing.T) {
	manifestPath := filepath.Join(t.TempDir(), "router.yml")
	if err := os.WriteFile(manifestPath, []byte(`name: Subscription Router
enabled_models:
  - openai/gpt-5.6-sol
  - anthropic/claude-fable-5
provider_key_sources:
  openai: managed
  anthropic: managed
subscription_providers:
  - Anthropic
  - openai
subscription_api_fallback_models:
  - anthropic/claude-fable-5
`), 0o644); err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	srv := routerSubscriptionTestServer(t, &body)
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "create", manifestPath})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari router create: %v", err)
	}
	if got, want := body["subscription_providers"], []any{"anthropic", "openai"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("subscription_providers = %#v, want %#v", got, want)
	}
	if got, want := body["subscription_api_fallback_models"], []any{"anthropic/claude-fable-5"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("subscription_api_fallback_models = %#v, want %#v", got, want)
	}
}

func TestRouterManifestRejectsInvalidSubscriptionFields(t *testing.T) {
	manifest := routerCreateManifest{
		Name:                  "Bad",
		EnabledModels:         []string{"openai/gpt-5.6-sol"},
		ProviderKeySources:    map[string]string{"openai": "managed"},
		SubscriptionProviders: []string{"xai"},
	}
	if _, err := manifest.createRequest("router.yml", nil); err == nil || !strings.Contains(err.Error(), "subscription_providers[0]") {
		t.Fatalf("err = %v, want subscription_providers error", err)
	}
	manifest.SubscriptionProviders = []string{"openai"}
	manifest.SubscriptionAPIFallbackModels = []string{"anthropic/claude-fable-5"}
	if _, err := manifest.createRequest("router.yml", nil); err == nil || !strings.Contains(err.Error(), "subscription_api_fallback_models[0]") {
		t.Fatalf("err = %v, want subscription_api_fallback_models error", err)
	}
}
