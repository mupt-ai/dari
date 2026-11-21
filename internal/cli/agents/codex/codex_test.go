package codex

import (
	"context"
	"encoding/json"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCodexCatalog(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Naming Codex gets the models a gateway lists for it.
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer test-key" || r.Header.Get("x-dari-client-harness") != "codex" {
			t.Errorf("unexpected catalog request")
		}
		_, _ = w.Write([]byte(`{"models":[{"slug":"dari/routing","context_window":272000,"auto_review_model_override":null,"support_verbosity":false,"web_search_tool_type":null,"tool_mode":null,"multi_agent_version":null}]}`))
	}))
	defer server.Close()
	data, disableWebSearch, err := Catalog(context.Background(), "test-key", server.URL, agents.Models{Routing: true})
	if err != nil {
		t.Fatal(err)
	}
	if !disableWebSearch {
		t.Fatal("a catalog without a web search tool type should disable web search")
	}
	var catalog struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	model := catalog.Models[0]
	if model["auto_review_model_override"] != agents.RoutingModel || model["context_window"] != float64(272000) || model["support_verbosity"] != false {
		t.Fatalf("model: %v", model)
	}
	if model["web_search_tool_type"] != "text" {
		t.Fatalf("invalid web search type: %v", model)
	}
	for _, field := range []string{"tool_mode", "multi_agent_version"} {
		if _, ok := model[field]; ok {
			t.Fatalf("null selector retained: %s", field)
		}
	}
}

func TestCodexCatalogOffersOnlyTheLaunchModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"models":[{"slug":"dari/routing","web_search_tool_type":"text"},{"slug":"dari/model/a/b","web_search_tool_type":"text"},{"slug":"dari/model/x/y","web_search_tool_type":"text"}]}`))
	}))
	defer server.Close()
	data, _, err := Catalog(context.Background(), "test-key", server.URL, agents.Models{Enabled: []string{"a/b"}})
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Models) != 1 || catalog.Models[0]["slug"] != "dari/model/a/b" || catalog.Models[0]["auto_review_model_override"] != "dari/model/a/b" {
		t.Fatalf("catalog: %v", catalog.Models)
	}
}

func TestCodexCatalogFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"unauthorized", "secret response body", 401},
		{"invalid json", "invalid", 200},
		{"missing router", `{"models":[{"slug":"other"}]}`, 200},
		{"oversized", strings.Repeat("x", (4<<20)+1), 200},
		{"redirect", "", 302},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", "/redirected")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			_, _, err := Catalog(context.Background(), "test-key", server.URL, agents.Models{Routing: true})
			if err == nil {
				t.Fatal("expected error")
			}
			if strings.Contains(err.Error(), "secret response body") || strings.Contains(err.Error(), "test-key") {
				t.Fatalf("leaked response or key: %v", err)
			}
		})
	}
}

func TestCodexLaunchClassification(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want bool
	}{
		{nil, true},
		{[]string{"fix tests"}, true},
		{[]string{"-c", "model=\"exec\"", "resume", "--last"}, true},
		{[]string{"--model", "review", "exec", "hello"}, false},
		{[]string{"-C", "exec", "fork", "--last"}, true},
		{[]string{"--", "exec"}, true},
		{[]string{"-c", "model=\"hello\"", "exec", "hello"}, false},
		{[]string{"mcp", "list"}, false},
		{[]string{"--config=model=\"hello\"", "review"}, false},
	} {
		if got := codexInteractiveArgs(tc.args); got != tc.want {
			t.Errorf("%q: got %v", tc.args, got)
		}
	}
	for _, tc := range []struct {
		version string
		want    bool
	}{
		{"codex-cli 0.162.1\n", true}, {"codex-cli 0.163.0", true},
		{"codex-cli 0.162.0", false}, {"codex-cli 0.144.0", false}, {"unknown", false},
	} {
		if codexSupportsStatusBridge(tc.version) != tc.want {
			t.Errorf("%s", tc.version)
		}
	}
}

func TestConfigureAlwaysDeclaresTheRoutersRemoteCompaction(t *testing.T) {
	for remote, want := range map[bool]string{false: `"unsupported"`, true: `"v2"`} {
		command := agents.Command{}
		Configure(&command, "https://routing.dari.dev", agents.Models{Routing: true, RemoteCompaction: remote})
		if !strings.Contains(strings.Join(command.Args, " "), "model_providers.dari.capabilities.remote_compaction="+want) {
			t.Fatalf("remoteCompaction=%v args: %v", remote, command.Args)
		}
	}
}

func TestLiveCatalogURL(t *testing.T) {
	body := `{"codex_direct":true,"models":[{"slug":"dari/routing"},{"slug":"dari/model/a/b"}]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Asked as Codex asks, so the gateway answers with what Codex will get.
		if r.URL.Path != "/rtr/v1/models" || r.URL.Query().Get("client_version") == "" || r.Header.Get("Authorization") != "Bearer k" {
			t.Errorf("unexpected request %s", r.URL)
		}
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	// httptest serves on 127.0.0.1, which Codex accepts over HTTP.
	got, err := LiveCatalogURL(context.Background(), "k", server.URL+"/rtr", "dari/model/a/b")
	if err != nil || got != server.URL+"/rtr/v1/models" {
		t.Fatalf("LiveCatalogURL = %q, %v", got, err)
	}
	// The list must hold the model Codex starts on.
	if got, _ := LiveCatalogURL(context.Background(), "k", server.URL+"/rtr", "dari/model/x/y"); got != "" {
		t.Fatalf("missing default model: %q", got)
	}
	// An older gateway does not mark its list: Codex could not parse it.
	body = `{"models":[{"slug":"dari/routing","web_search_tool_type":null}]}`
	if got, _ := LiveCatalogURL(context.Background(), "k", server.URL+"/rtr", "dari/routing"); got != "" {
		t.Fatalf("unmarked list: %q", got)
	}
}

func TestLiveCatalogURLReportsAnUnreachableRouter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	if got, err := LiveCatalogURL(context.Background(), "k", server.URL, "dari/routing"); got != "" || err == nil {
		t.Fatalf("LiveCatalogURL = %q, %v; want an error", got, err)
	}
}

// Codex will not start with a model_catalog_url it refuses, so setup only
// names one Codex accepts: HTTPS, or HTTP to this machine.
func TestCodexAcceptsCatalogURL(t *testing.T) {
	for raw, want := range map[string]bool{
		"https://routing.dari.dev/rtr_1/v1/models": true,
		"http://127.0.0.1:7340/v1/models":          true,
		"http://localhost:7340/v1/models":          true,
		"http://[::1]:7340/v1/models":              true,
		"http://192.168.1.20:7340/v1/models":       false,
		"http://gateway.lan/v1/models":             false,
		"https://user:pw@routing.dari.dev/v1":      false,
		"https://routing.dari.dev/v1/models#x":     false,
		"https:///v1/models":                       false,
	} {
		if got := codexAcceptsCatalogURL(raw); got != want {
			t.Errorf("codexAcceptsCatalogURL(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestReadsLiveCatalogVersion(t *testing.T) {
	for version, want := range map[string]bool{
		"codex-cli 0.171.0":            true,
		"codex-cli 0.162.0-alpha.17.2": true,
		"codex-cli 0.156.0":            true,
		"codex-cli 1.0.0":              true,
		"codex-cli 0.155.9":            false,
		"codex-cli 0.153.4":            false,
		"codex-cli 0.156":              false,
		"unknown":                      false,
		"":                             false,
	} {
		if got := ReadsLiveCatalogVersion(version); got != want {
			t.Errorf("ReadsLiveCatalogVersion(%q) = %v, want %v", version, got, want)
		}
	}
}
