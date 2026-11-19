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
		// --pay and --default answer the picker; they leave with --template.
		{"pay and default", []string{"--template", "deepseek-subagent", "--pay", "deepseek=credits", "--default", "-p", "hi"}, "deepseek-subagent", []string{"-p", "hi"}, false, 1},
		{"pay without template", []string{"--pay", "deepseek=credits"}, "", nil, true, 0},
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
// settings chose, unless the template's publisher no longer allows it or
// --pay picks another; with nothing allowed left to pay, it saves nothing.
// --default makes the copy the agent's router.
func TestExperimentRelaunchKeepsTheCopysPayment(t *testing.T) {
	gpt := agentExperiment{Flag: "deepseek-subagent", Name: "DeepSeek Subagent", AllowBYOK: true, AllowManaged: true}
	withPay := func(pay map[string]string, makeDefault bool) agentExperiment {
		experiment := gpt
		experiment.pay, experiment.makeDefault = pay, makeDefault
		return experiment
	}
	cases := []struct {
		name         string
		experiment   agentExperiment
		wantKey      bool
		wantErr      bool
		wantAssigned bool
	}{
		{"--pay credits", withPay(map[string]string{"gpt": "credits"}, false), false, false, false},
		{"--pay with no such subscription", withPay(map[string]string{"openai/gpt": "subscription"}, false), false, true, false},
		{"--default", withPay(nil, true), true, false, true},
		{"own key kept", gpt, true, false, false},
		{"own key blocked by publisher", agentExperiment{Flag: "deepseek-subagent", Name: "DeepSeek Subagent", AllowManaged: true}, false, false, false},
		// Without a subscription, nothing the publisher allows can pay.
		{"everything blocked", agentExperiment{Flag: "deepseek-subagent", Name: "DeepSeek Subagent"}, false, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var put map[string]any
			assigned := false
			server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/v1/organizations/current/routers/rtr_copy/coding-agents/claude_code":
					assigned = true
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
					_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{{
						"id": "rtr_copy", "client_key": "dari-experiment:deepseek-subagent", "enabled_models": []string{"openai/gpt"},
						"model_providers": map[string]string{"openai/gpt": "openai"}, "provider_key_sources": map[string]string{"openai": "user"},
					}}})
				case strings.HasSuffix(r.URL.Path, "/apply"):
					// The sync resets the payment to Dari Credits.
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
			if routerID != "rtr_copy" || put == nil || assigned != tc.wantAssigned {
				t.Fatalf("router = %q, put = %v, assigned = %v", routerID, put, assigned)
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

// A template may serve a model through another provider than the catalog
// names, here OpenCode Go, which only a subscription pays for. The copy then
// keeps no payment for the catalog's provider, which serves none of its
// models, and none for OpenCode Go, which takes no key or Dari Credits.
func TestExperimentPaysThroughTheTemplatesProvider(t *testing.T) {
	var put map[string]any
	copyRouter := map[string]any{
		"id": "rtr_copy", "client_key": "dari-experiment:flash", "coding_agents": []string{}, "enabled_models": []string{"deepseek/flash"},
		"model_providers": map[string]string{"deepseek/flash": "opencode-go"}, "subscription_providers": []string{"opencode-go"},
		"subscription_models": []string{"deepseek/flash"},
	}
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{copyRouter}})
		case strings.HasSuffix(r.URL.Path, "/apply"):
			_ = json.NewEncoder(w).Encode(copyRouter)
		case r.URL.Path == "/v1/organizations/current/routers/model-catalog":
			_ = json.NewEncoder(w).Encode(map[string]any{"groups": []map[string]any{{
				"provider": "fireworks", "provider_label": "Fireworks", "supports_managed_key": true,
				"models": []map[string]any{{"id": "deepseek/flash", "display_name": "Flash", "provider": "fireworks", "default_provider": "fireworks", "supports_managed_key": true}},
			}}})
		case r.URL.Path == "/v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []map[string]any{{"oauth_provider": "opencode_go"}}})
		case r.Method == http.MethodPut:
			_ = json.NewDecoder(r.Body).Decode(&put)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_copy"})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{})
		}
	}))
	defer server.Close()
	client := api.New(server.URL).WithBearer("dari_test")
	experiment := agentExperiment{Flag: "flash", Name: "Flash", AllowBYOK: true, AllowManaged: true}
	if _, err := applyAgentExperiment(context.Background(), client, "claude", experiment, strings.NewReader(""), io.Discard); err != nil {
		t.Fatal(err)
	}
	if sources, _ := put["provider_key_sources"].(map[string]any); len(sources) != 0 {
		t.Fatalf("provider_key_sources = %v", sources)
	}
}

// A template model whose only way to pay is a setup step can still run it:
// Continue refuses until it does, and enter on the model asks for it.
func TestTemplatePickerRunsAModelsOnlySetupStep(t *testing.T) {
	model := agentModel{ID: "deepseek/flash", DisplayName: "Flash", Provider: "deepseek"}
	p := newAgentPickerState([]agentModel{model}, []string{model.ID}, nil, nil, map[string][]agentModelSource{
		model.ID: {{kind: "connect", provider: "opencode-go", label: "Connect OpenCode Go"}},
	})
	p.paying, p.fixed = true, true
	p.cursor = len(p.items()) - 1
	if done, _ := p.handleKey("enter"); done || p.warning == "" {
		t.Fatalf("continue: done = %v, warning = %q", done, p.warning)
	}
	p.cursor = 0
	if done, _ := p.handleKey("enter"); !done || p.action != 0 {
		t.Fatalf("enter: done = %v, action = %d", done, p.action)
	}
}
