package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanModelProvidersRequiresExactEnabledModelCoverage(t *testing.T) {
	_, err := cleanModelProviders("router.yml", map[string]string{
		"openai/gpt-5.6-sol": "openrouter",
	}, []string{"openai/gpt-5.6-sol", "xai/grok-4.5"})
	if err == nil || !strings.Contains(err.Error(), "must contain every enabled_models entry") {
		t.Fatalf("cleanModelProviders error = %v", err)
	}
}

func TestValidateManifestProviderKeysRejectsInvalidModelBeforeMappingLookup(t *testing.T) {
	err := validateManifestProviderKeys(
		"router.yml",
		map[string]string{"openrouter": "user"},
		map[string]string{"openrouter": "or-key"},
		[]string{"invalid-model"},
		map[string]string{"invalid-model": "openrouter"},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "must be a provider-prefixed model ID") {
		t.Fatalf("validateManifestProviderKeys error = %v", err)
	}
}

func TestManifestOwnerNamespacesUseCatalogDefaultProviders(t *testing.T) {
	for _, model := range []string{
		"zai-org/GLM-5.2",
		"deepseek-ai/DeepSeek-V4-Flash-0731",
		"moonshotai/Kimi-K3",
	} {
		t.Run(model, func(t *testing.T) {
			err := validateManifestProviderKeys(
				"router.yml",
				map[string]string{"fireworks": "user"},
				map[string]string{"fireworks": "fw-key"},
				[]string{model},
				nil,
				func() (map[string]string, error) {
					return map[string]string{model: "fireworks"}, nil
				},
			)
			if err != nil {
				t.Fatalf("validateManifestProviderKeys error = %v", err)
			}
		})
	}
}

func TestManifestOwnerNamespaceWithoutCatalogDefaultFallsBackToNamespace(t *testing.T) {
	// Without catalog data the namespace is the only available default, so a
	// fireworks key no longer matches any provider and the mismatch surfaces.
	err := validateManifestProviderKeys(
		"router.yml",
		map[string]string{"fireworks": "user"},
		map[string]string{"fireworks": "fw-key"},
		[]string{"zai-org/GLM-5.2"},
		nil,
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "does not match any enabled_models provider") {
		t.Fatalf("validateManifestProviderKeys error = %v", err)
	}
}

func TestManifestOwnerNamespaceUsesExplicitProviderBinding(t *testing.T) {
	err := validateManifestProviderKeys(
		"router.yml",
		map[string]string{"fireworks": "user"},
		map[string]string{"fireworks": "fw-key"},
		[]string{"zai-org/GLM-5.2"},
		map[string]string{"zai-org/GLM-5.2": "fireworks"},
		nil,
	)
	if err != nil {
		t.Fatalf("validateManifestProviderKeys error = %v", err)
	}
}

func TestManifestGatewayBindingUsesGatewayCredential(t *testing.T) {
	for _, gateway := range []string{"openrouter", "vercel-ai-gateway"} {
		err := validateManifestProviderKeys(
			"router.yml",
			map[string]string{gateway: "user"},
			map[string]string{gateway: "gateway-key"},
			[]string{"openai/gpt-5.6-sol"},
			map[string]string{"openai/gpt-5.6-sol": gateway},
			nil,
		)
		if err != nil {
			t.Fatalf("%s validateManifestProviderKeys error = %v", gateway, err)
		}
	}
}

func TestRouterCreateManifestResolvesCatalogDefaultProviders(t *testing.T) {
	manifestDir := t.TempDir()
	manifestPath := filepath.Join(manifestDir, "router.yml")
	manifest := `name: Catalog Router
enabled_models:
  - zai-org/GLM-5.2
provider_key_sources:
  fireworks: user
provider_keys:
  fireworks: fw-key
routing_strategy: dari
`
	if err := os.WriteFile(manifestPath, []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}

	var createBody map[string]any
	catalogCalls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
			catalogCalls++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"groups":[{"models":[{"id":"zai-org/GLM-5.2","provider":"fireworks","default_provider":"fireworks"}]}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/routers":
			if err := json.NewDecoder(r.Body).Decode(&createBody); err != nil {
				t.Fatalf("decode create body: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"rtr_1"}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "router", "create", manifestPath})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatal(err)
	}
	if catalogCalls != 1 {
		t.Fatalf("catalog calls = %d, want 1", catalogCalls)
	}
	keys, ok := createBody["provider_keys"].(map[string]any)
	if !ok || keys["fireworks"] != "fw-key" {
		t.Fatalf("provider_keys = %v", createBody["provider_keys"])
	}
}

func TestManifestSavedCredentialsBindBuiltInCloudProviders(t *testing.T) {
	for _, provider := range []string{"amazon-bedrock", "azure"} {
		if !manifestProviderUsesManifestCredentials(provider) {
			t.Fatalf("%s should take manifest credentials like other built-in providers", provider)
		}
		err := validateManifestProviderKeys(
			"router.yml",
			map[string]string{provider: "user"},
			map[string]string{provider: "cred_saved"},
			[]string{"openai/gpt-5.6-sol"},
			map[string]string{"openai/gpt-5.6-sol": provider},
			nil,
		)
		if err != nil {
			t.Fatalf("%s manifest with a saved credential: %v", provider, err)
		}
	}
	if manifestProviderUsesManifestCredentials("acme") {
		t.Fatal("custom providers resolve credentials from the model catalog")
	}
}
