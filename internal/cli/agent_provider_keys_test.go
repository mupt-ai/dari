package cli

import (
	"context"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/api"
)

// providerKeysTestModels are the selected models: Fable and Sol are served
// by the Vercel AI Gateway, GLM is not.
func providerKeysTestModels() ([]agentModel, []agentModelChoice) {
	models := []agentModel{
		{ID: "anthropic/claude-fable-5-1", DisplayName: "Fable 5.1", Provider: "anthropic", DefaultProvider: "anthropic", SupportsManagedKey: true},
		{ID: "openai/gpt-5.6-sol", DisplayName: "Sol", Provider: "openai", DefaultProvider: "openai", SupportsManagedKey: true},
		{ID: "zai-org/GLM-5.3", DisplayName: "GLM", Provider: "fireworks", DefaultProvider: "fireworks", SupportsManagedKey: true},
	}
	choices := []agentModelChoice{
		{ID: "anthropic/claude-fable-5-1", Levels: []string{"high"}},
		{ID: "openai/gpt-5.6-sol", Levels: []string{"medium"}},
		{ID: "zai-org/GLM-5.3", Levels: []string{"high"}},
	}
	return models, choices
}

func writeProviderKeysCatalog(w http.ResponseWriter) {
	group := func(provider, label string, managed bool, ids ...string) map[string]any {
		models := []map[string]any{}
		for _, id := range ids {
			models = append(models, map[string]any{"id": id, "display_name": id, "provider": provider, "supports_managed_key": managed})
		}
		return map[string]any{"provider": provider, "provider_label": label, "supports_managed_key": managed, "models": models}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"groups": []map[string]any{
		group("anthropic", "Anthropic", true, "anthropic/claude-fable-5-1"),
		group("openai", "OpenAI", true, "openai/gpt-5.6-sol"),
		group("fireworks", "Fireworks", true, "zai-org/GLM-5.3"),
		group("vercel-ai-gateway", "Vercel AI Gateway", false, "anthropic/claude-fable-5-1", "openai/gpt-5.6-sol"),
		group("openrouter", "OpenRouter", false, "anthropic/claude-fable-5-1"),
	}})
}

// providerKeysTestServer serves the catalog and the given credentials, and
// records saved provider credentials as cred_new.
func providerKeysTestServer(t *testing.T, credentials []map[string]any, saved *[]map[string]any) *api.Client {
	t.Helper()
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
			writeProviderKeysCatalog(w)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": credentials})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/credentials/provider-credentials":
			if saved == nil {
				t.Errorf("unexpected credential save")
				http.Error(w, "unexpected", http.StatusBadRequest)
				return
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			*saved = append(*saved, body)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "cred_new", "provider": body["provider"]})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return api.New(server.URL)
}

func agentKeyCredential(id, provider, label string) map[string]any {
	return map[string]any{"id": id, "provider": provider, "credential_scope": "organization", "auth_scheme": "api_key", "label": label}
}

func TestAgentProviderKeysWithoutKeysKeepDariCredits(t *testing.T) {
	models, choices := providerKeysTestModels()
	client := providerKeysTestServer(t, []map[string]any{
		{"id": "cred_sub", "oauth_provider": "anthropic_claude_code", "credential_scope": "user"},
	}, nil)
	body := agentRouterCreateBody(agentSetups["claude"], models, choices, nil)

	var stderr strings.Builder
	keys, err := agentProviderKeysFor(context.Background(), client, &stderr, models, body.EnabledModels, body.ModelProviders, nil)
	if err != nil {
		t.Fatal(err)
	}
	keys.apply(body.ModelProviders, body.ProviderKeySources)
	body.ProviderCredentialIDs = keys.credentialIDs

	if want := map[string]string{"anthropic": "managed", "openai": "managed", "fireworks": "managed"}; !maps.Equal(body.ProviderKeySources, want) {
		t.Errorf("provider_key_sources = %v, want %v", body.ProviderKeySources, want)
	}
	encoded, _ := json.Marshal(body)
	if strings.Contains(string(encoded), "provider_credential_ids") || !strings.Contains(stderr.String(), "Dari credits for Fable 5.1, Sol, GLM") {
		t.Errorf("payload = %s, stderr = %q", encoded, stderr.String())
	}
}

func TestAgentProviderKeysGatewayServesWhatItCan(t *testing.T) {
	models, choices := providerKeysTestModels()
	client := providerKeysTestServer(t, []map[string]any{
		agentKeyCredential("cred_team", "vercel-ai-gateway", "Team gateway"),
	}, nil)
	body := agentRouterCreateBody(agentSetups["claude"], models, choices, nil)

	var stderr strings.Builder
	keys, err := agentProviderKeysFor(context.Background(), client, &stderr, models, body.EnabledModels, body.ModelProviders, nil)
	if err != nil {
		t.Fatal(err)
	}
	keys.apply(body.ModelProviders, body.ProviderKeySources)
	body.ProviderCredentialIDs = keys.credentialIDs

	if want := map[string]string{
		"anthropic/claude-fable-5-1": "vercel-ai-gateway",
		"openai/gpt-5.6-sol":         "vercel-ai-gateway",
		"zai-org/GLM-5.3":            "fireworks",
	}; !maps.Equal(body.ModelProviders, want) {
		t.Errorf("model_providers = %v, want %v", body.ModelProviders, want)
	}
	if want := map[string]string{"vercel-ai-gateway": "user", "fireworks": "managed"}; !maps.Equal(body.ProviderKeySources, want) {
		t.Errorf("provider_key_sources = %v, want %v", body.ProviderKeySources, want)
	}
	if want := map[string]string{"vercel-ai-gateway": "cred_team"}; !maps.Equal(body.ProviderCredentialIDs, want) {
		t.Errorf("provider_credential_ids = %v, want %v", body.ProviderCredentialIDs, want)
	}
	if !strings.Contains(stderr.String(), "Vercel AI Gateway key for Fable 5.1, Sol; Dari credits for GLM") {
		t.Errorf("stderr = %q", stderr.String())
	}
}

func TestAgentProviderKeysPreferDirectKeysOverGateways(t *testing.T) {
	models, choices := providerKeysTestModels()
	client := providerKeysTestServer(t, []map[string]any{
		agentKeyCredential("cred_router", "openrouter", "Router"),
		agentKeyCredential("cred_anthropic", "anthropic", "Anthropic"),
	}, nil)
	body := agentRouterCreateBody(agentSetups["claude"], models, choices, nil)

	keys, err := agentProviderKeysFor(context.Background(), client, io.Discard, models, body.EnabledModels, body.ModelProviders, nil)
	if err != nil {
		t.Fatal(err)
	}
	keys.apply(body.ModelProviders, body.ProviderKeySources)

	// OpenRouter serves only Fable in the test catalog, and Fable has a direct key.
	if want := map[string]string{
		"anthropic/claude-fable-5-1": "anthropic",
		"openai/gpt-5.6-sol":         "openai",
		"zai-org/GLM-5.3":            "fireworks",
	}; !maps.Equal(body.ModelProviders, want) {
		t.Errorf("model_providers = %v, want %v", body.ModelProviders, want)
	}
	if want := map[string]string{"anthropic": "cred_anthropic"}; !maps.Equal(keys.credentialIDs, want) {
		t.Errorf("credential IDs = %v, want %v", keys.credentialIDs, want)
	}
}

func TestAgentProviderKeysKeepSubscriptionModels(t *testing.T) {
	models, choices := providerKeysTestModels()
	client := providerKeysTestServer(t, []map[string]any{
		agentKeyCredential("cred_team", "vercel-ai-gateway", "Team gateway"),
		agentKeyCredential("cred_anthropic", "anthropic", "Anthropic"),
	}, nil)
	body := agentRouterCreateBody(agentSetups["claude"], models, choices, []agentSubscriptionProvider{claudeSubscription})

	keys, err := agentProviderKeysFor(context.Background(), client, io.Discard, models, body.EnabledModels, body.ModelProviders, []agentSubscriptionProvider{claudeSubscription})
	if err != nil {
		t.Fatal(err)
	}
	keys.apply(body.ModelProviders, body.ProviderKeySources)

	if body.ModelProviders["anthropic/claude-fable-5-1"] != "anthropic" || body.ModelProviders["openai/gpt-5.6-sol"] != "vercel-ai-gateway" {
		t.Errorf("model_providers = %v", body.ModelProviders)
	}
	// The Anthropic key only takes over while the subscription is unavailable.
	if want := []string{"anthropic/claude-fable-5-1"}; !slices.Equal(keys.apiFallbackModels, want) {
		t.Errorf("api fallback models = %v, want %v", keys.apiFallbackModels, want)
	}
}

func TestAttachAgentProviderKeysKeepsTheRoutersModels(t *testing.T) {
	models, _ := providerKeysTestModels()
	router := agentRouter{
		ID:                  "rtr_winner",
		Name:                "Claude Code",
		EnabledModels:       []string{"anthropic/claude-fable-5-1", "zai-org/GLM-5.3"},
		ModelProviders:      map[string]string{"anthropic/claude-fable-5-1": "anthropic", "zai-org/GLM-5.3": "fireworks"},
		ModelThinkingLevels: map[string][]string{"anthropic/claude-fable-5-1": {"max"}, "zai-org/GLM-5.3": {"high"}},
	}
	// Chosen for this launch's picks: Sol is not on the winning router.
	keys := agentProviderKeys{
		modelProviders: map[string]string{"anthropic/claude-fable-5-1": "vercel-ai-gateway", "openai/gpt-5.6-sol": "vercel-ai-gateway"},
		credentialIDs:  map[string]string{"vercel-ai-gateway": "cred_vercel"},
	}
	var put agentRouterUpdateRequest
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/v1/organizations/current/routers/rtr_winner" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&put); err != nil {
			t.Error(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_winner"})
	}))
	t.Cleanup(server.Close)

	if _, err := attachAgentProviderKeys(context.Background(), api.New(server.URL), router, models, keys); err != nil {
		t.Fatal(err)
	}
	if strings.Join(put.EnabledModels, ",") != "anthropic/claude-fable-5-1,zai-org/GLM-5.3" {
		t.Fatalf("enabled models = %v, want the router's own", put.EnabledModels)
	}
	if !maps.Equal(put.ModelProviders, map[string]string{"anthropic/claude-fable-5-1": "vercel-ai-gateway", "zai-org/GLM-5.3": "fireworks"}) {
		t.Fatalf("model providers = %v", put.ModelProviders)
	}
	if put.ProviderKeySources["vercel-ai-gateway"] != "user" || put.ProviderCredentialIDs["vercel-ai-gateway"] != "cred_vercel" {
		t.Fatalf("key sources = %v, credential ids = %v", put.ProviderKeySources, put.ProviderCredentialIDs)
	}
	if levels := put.ModelThinkingLevels["anthropic/claude-fable-5-1"]; strings.Join(levels, ",") != "max" {
		t.Fatalf("thinking levels = %v, want the router's own", put.ModelThinkingLevels)
	}
}

func TestAgentProviderKeysDirectKeyOnSubscriptionBecomesAPIFallback(t *testing.T) {
	models, choices := providerKeysTestModels()
	client := providerKeysTestServer(t, []map[string]any{agentKeyCredential("cred_anthropic", "anthropic", "Anthropic")}, nil)
	body := agentRouterCreateBody(agentSetups["claude"], models, choices, []agentSubscriptionProvider{claudeSubscription})

	var stderr strings.Builder
	keys, err := agentProviderKeysFor(context.Background(), client, &stderr, models, body.EnabledModels, body.ModelProviders, []agentSubscriptionProvider{claudeSubscription})
	if err != nil {
		t.Fatal(err)
	}

	if want := []string{"anthropic/claude-fable-5-1"}; !slices.Equal(keys.apiFallbackModels, want) {
		t.Fatalf("API fallback models = %v, want %v", keys.apiFallbackModels, want)
	}
	if got := keys.fallbackModels([]string{"zai-org/GLM-5.3", "removed/model"}, body.EnabledModels); !slices.Equal(got, []string{"zai-org/GLM-5.3", "anthropic/claude-fable-5-1"}) {
		t.Fatalf("merged API fallback models = %v", got)
	}
	if !strings.Contains(stderr.String(), "Claude Code subscription for Fable 5.1") {
		t.Errorf("stderr = %q", stderr.String())
	}
	// Without a direct key on a subscribed provider, the router's API
	// fallback is left as it is.
	if got := (agentProviderKeys{}).fallbackModels([]string{"zai-org/GLM-5.3"}, body.EnabledModels); got != nil {
		t.Fatalf("fallback models without subscription keys = %v, want nil", got)
	}
}
