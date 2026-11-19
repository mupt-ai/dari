package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/api"
)

func experimentServer(t *testing.T, requests *[]string) *api.Client {
	t.Helper()
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*requests = append(*requests, r.Method+" "+r.URL.Path)
		switch {
		case r.URL.Path == "/v1/organizations/current/experimental-routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"experimental_routers": []map[string]any{
				{"flag": "deepseek-subagent", "name": "DeepSeek Subagent"},
			}})
		case strings.HasSuffix(r.URL.Path, "/apply"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_experiment", "coding_agents": []string{}})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{})
		}
	}))
	t.Cleanup(server.Close)
	return api.New(server.URL).WithBearer("dari_test")
}

func TestTemplateIsTakenOutOfTheAgentsArguments(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		template string
		wantArgs []string
		wantErr  bool
		lookups  int
	}{
		{"separate value", []string{"--resume", "--template", "deepseek-subagent", "-p", "hi"}, "deepseek-subagent", []string{"--resume", "-p", "hi"}, false, 1},
		{"equals value", []string{"--template=deepseek-subagent"}, "deepseek-subagent", []string{}, false, 1},
		{"unknown template", []string{"--template", "nope"}, "", nil, true, 1},
		{"missing name", []string{"--template"}, "", nil, true, 0},
		{"after --", []string{"--", "--template", "deepseek-subagent"}, "", []string{"--", "--template", "deepseek-subagent"}, false, 0},
		// Agent flags never trigger a lookup.
		{"agent flags only", []string{"--resume", "--deepseek-subagent"}, "", []string{"--resume", "--deepseek-subagent"}, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var requests []string
			client := experimentServer(t, &requests)
			launch := agentLaunch{name: "claude", args: slices.Clone(tc.args)}
			experiment, err := takeAgentExperiment(context.Background(), client, &launch, io.Discard)
			if (err != nil) != tc.wantErr || len(requests) != tc.lookups {
				t.Fatalf("err = %v, requests = %v", err, requests)
			}
			if tc.wantErr {
				return
			}
			template := ""
			if experiment != nil {
				template = experiment.Flag
			}
			if template != tc.template || !slices.Equal(launch.args, tc.wantArgs) {
				t.Fatalf("template = %q, args = %v", template, launch.args)
			}
		})
	}
}

// A launch without a terminal syncs the copy and keeps the payment its
// settings chose, unless the template's publisher no longer allows it; with
// nothing allowed left to pay, it saves nothing.
func TestExperimentRelaunchKeepsTheCopysPayment(t *testing.T) {
	cases := []struct {
		name       string
		experiment agentExperiment
		wantKey    bool
		wantErr    bool
	}{
		{"own key kept", agentExperiment{Flag: "deepseek-subagent", Name: "DeepSeek Subagent", AllowBYOK: true, AllowManaged: true}, true, false},
		{"own key blocked by publisher", agentExperiment{Flag: "deepseek-subagent", Name: "DeepSeek Subagent", AllowManaged: true}, false, false},
		// Without a subscription, nothing the publisher allows can pay.
		{"everything blocked", agentExperiment{Flag: "deepseek-subagent", Name: "DeepSeek Subagent"}, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var put map[string]any
			server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
					_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{{
						"id": "rtr_copy", "client_key": "dari-experiment:deepseek-subagent", "enabled_models": []string{"openai/gpt"},
						"model_providers": map[string]string{"openai/gpt": "openai"}, "provider_key_sources": map[string]string{"openai": "user"},
					}}})
				case strings.HasSuffix(r.URL.Path, "/apply"):
					// The sync resets the payment to Dari credits.
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_copy", "coding_agents": []string{}, "enabled_models": []string{"openai/gpt"},
						"model_providers": map[string]string{"openai/gpt": "openai"}, "provider_key_sources": map[string]string{"openai": "managed"}})
				case r.URL.Path == "/v1/organizations/current/routers/model-catalog":
					_ = json.NewEncoder(w).Encode(map[string]any{"groups": []map[string]any{{
						"provider": "openai", "provider_label": "OpenAI", "supports_managed_key": true,
						"models": []map[string]any{{"id": "openai/gpt", "display_name": "GPT", "provider": "openai", "default_provider": "openai", "supports_managed_key": true}},
					}}})
				case r.URL.Path == "/v1/organizations/current/credentials" && r.Method == http.MethodGet:
					_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []map[string]any{{
						"id": "cred_openai", "provider": "openai", "credential_scope": "organization", "auth_scheme": "api_key",
					}}})
				case r.Method == http.MethodPut && r.URL.Path == "/v1/organizations/current/routers/rtr_copy":
					_ = json.NewDecoder(r.Body).Decode(&put)
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_copy"})
				default:
					_ = json.NewEncoder(w).Encode(map[string]any{})
				}
			}))
			defer server.Close()
			client := api.New(server.URL).WithBearer("dari_test")

			routerID, err := applyAgentExperiment(context.Background(), client, "claude", tc.experiment, strings.NewReader(""), io.Discard)
			if tc.wantErr {
				if err == nil || put != nil {
					t.Fatalf("err = %v, put = %v", err, put)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if routerID != "rtr_copy" || put == nil {
				t.Fatalf("router = %q, put = %v", routerID, put)
			}
			credentials, hasKey := put["provider_credential_ids"].(map[string]any)
			if hasKey != tc.wantKey || (tc.wantKey && credentials["openai"] != "cred_openai") {
				t.Fatalf("provider_credential_ids = %v", put["provider_credential_ids"])
			}
		})
	}
}

func TestRouterPublishCommandNeedsOnlyTheRouter(t *testing.T) {
	var requested string
	var body map[string]any
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = r.Method + " " + r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]any{"flag": "deepseek-subagent"})
	}))
	defer server.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"--api-url", server.URL, "router", "publish", "rtr_source"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("dari router publish: %v", err)
	}
	if want := "POST /v1/organizations/current/experimental-routers"; requested != want {
		t.Fatalf("request = %q, want %q", requested, want)
	}
	// The server picks the flag and name from the router.
	if body["source_router_id"] != "rtr_source" || body["flag"] != nil {
		t.Fatalf("body = %v", body)
	}
	if !strings.Contains(out.String(), "dari <agent> --template deepseek-subagent") {
		t.Fatalf("output = %q", out.String())
	}
}
