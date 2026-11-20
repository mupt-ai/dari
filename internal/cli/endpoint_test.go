package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

const endpointGrantsJSON = `{"grants":[` +
	`{"id":"lgr_app","app_name":"Notes","endpoint":false,"credential_ids":["cred_codex"],"limits":[]},` +
	`{"id":"lgr_me","app_name":"Cursor","endpoint":true,"credential_ids":["cred_codex","cred_key"],` +
	`"limits":[{"credential_id":"cred_codex","monthly_usd":50}],` +
	`"spend":[{"credential_id":"cred_codex","spent_usd":3.5,"monthly_usd":50,"reached":false}]}]}`

// The routing service's Link routes, recording each request's body.
func endpointTestServer(t *testing.T, bodies map[string]map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := r.Method + " " + r.URL.Path
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			var body map[string]any
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatalf("decode %s: %v", route, err)
			}
			bodies[route] = body
		}
		switch route {
		case "GET /v1/link/grants":
			_, _ = w.Write([]byte(endpointGrantsJSON))
		case "POST /v1/link/endpoints":
			_, _ = w.Write([]byte(`{"grant":{"id":"lgr_new"},"key":"dlk_key_personal"}`))
		case "PUT /v1/link/grants/lgr_me", "PUT /v1/link/grants/lgr_me/limits":
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Fatalf("unexpected request %s", route)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func runEndpointCmd(t *testing.T, srv *httptest.Server, args ...string) string {
	t.Helper()
	useTestAPIKey(t)
	cmd := newRootCmd("dev")
	var out strings.Builder
	cmd.SetOut(&out)
	cmd.SetArgs(append([]string{"--api-url", srv.URL, "endpoint"}, args...))
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari endpoint %v: %v", args, err)
	}
	return out.String()
}

func TestEndpointCreateSendsPlansWithLimitsAndPrintsAccess(t *testing.T) {
	bodies := map[string]map[string]any{}
	srv := endpointTestServer(t, bodies)

	out := runEndpointCmd(t, srv, "create", "Cursor", "--credential", "cred_codex=$50", "--credential", "cred_key")

	want := map[string]any{
		"name":           "Cursor",
		"credential_ids": []any{"cred_codex", "cred_key"},
		"limits":         []any{map[string]any{"credential_id": "cred_codex", "monthly_usd": 50.0}},
	}
	if got := bodies["POST /v1/link/endpoints"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("body = %#v, want %#v", got, want)
	}
	for _, line := range []string{
		"OpenAI Base URL:     " + srv.URL + "/v1\n",
		"Anthropic Base URL:  " + srv.URL + "\n",
		"API Key:             dlk_key_personal",
		personalEndpointTerms,
	} {
		if !strings.Contains(out, line) {
			t.Fatalf("output missing %q:\n%s", line, out)
		}
	}
}

func TestEndpointUpdateFindsItByNameAndReplacesPlansAndLimits(t *testing.T) {
	bodies := map[string]map[string]any{}
	srv := endpointTestServer(t, bodies)

	runEndpointCmd(t, srv, "update", "Cursor", "--name", "Zed", "--credential", "cred_key=10")

	if got, want := bodies["PUT /v1/link/grants/lgr_me"], map[string]any{
		"name":           "Zed",
		"credential_ids": []any{"cred_key"},
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("grant body = %#v, want %#v", got, want)
	}
	if got, want := bodies["PUT /v1/link/grants/lgr_me/limits"], map[string]any{
		"limits": []any{map[string]any{"credential_id": "cred_key", "monthly_usd": 10.0}},
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("limits body = %#v, want %#v", got, want)
	}
}

func TestEndpointListShowsOnlyEndpoints(t *testing.T) {
	srv := endpointTestServer(t, map[string]map[string]any{})
	var listed struct {
		Endpoints []struct {
			ID string `json:"id"`
		} `json:"endpoints"`
	}
	useTestAPIKey(t)
	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{"--api-url", srv.URL, "endpoint", "list"})
	out, err := captureStdoutBytes(t, func() error { return cmd.Execute() })
	if err != nil {
		t.Fatalf("dari endpoint list: %v", err)
	}
	if err := json.Unmarshal(out, &listed); err != nil {
		t.Fatalf("decode %q: %v", out, err)
	}
	if len(listed.Endpoints) != 1 || listed.Endpoints[0].ID != "lgr_me" {
		t.Fatalf("endpoints = %#v", listed.Endpoints)
	}
}

func TestEndpointCredentialLimitMustBeDollars(t *testing.T) {
	if _, _, err := parseEndpointCredentials([]string{"cred_codex=lots"}); err == nil {
		t.Fatal("want an error for a non-dollar limit")
	}
}
