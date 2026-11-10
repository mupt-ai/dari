package codex

import (
	"context"
	"encoding/json"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestPrepareCodexCatalog(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("unexpected catalog request")
		}
		_, _ = w.Write([]byte(`{"models":[{"slug":"dari/routing","context_window":272000,"auto_review_model_override":null,"support_verbosity":false,"web_search_tool_type":null,"tool_mode":null,"multi_agent_version":null}]}`))
	}))
	defer server.Close()
	command := agents.Command{Args: []string{"-c", `approvals_reviewer="auto_review"`, "--", "prompt"}}
	if err := PrepareCatalog(context.Background(), &command, "test-key", server.URL, agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	defer command.Cleanup()
	if command.Args[1] != `approvals_reviewer="auto_review"` || command.Args[6] != "--" || command.Args[5] != `web_search="disabled"` {
		t.Fatalf("args: %v", command.Args)
	}
	path, err := strconv.Unquote(strings.TrimPrefix(command.Args[3], "model_catalog_json="))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("permissions: %v", info.Mode())
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
	command.Cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("catalog not cleaned up: %v", err)
	}
}

func TestPrepareCodexCatalogOffersOnlyTheLaunchModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"models":[{"slug":"dari/routing","web_search_tool_type":"text"},{"slug":"dari/model/a/b","web_search_tool_type":"text"},{"slug":"dari/model/x/y","web_search_tool_type":"text"}]}`))
	}))
	defer server.Close()
	command := agents.Command{}
	if err := PrepareCatalog(context.Background(), &command, "test-key", server.URL, agents.Models{Enabled: []string{"a/b"}}); err != nil {
		t.Fatal(err)
	}
	defer command.Cleanup()
	path, err := strconv.Unquote(strings.TrimPrefix(command.Args[1], "model_catalog_json="))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
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

func TestPrepareCodexCatalogFailsClosed(t *testing.T) {
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
			command := agents.Command{}
			err := PrepareCatalog(context.Background(), &command, "test-key", server.URL, agents.Models{Routing: true})
			if err == nil {
				t.Fatal("expected error")
			}
			if strings.Contains(err.Error(), "secret response body") || strings.Contains(err.Error(), "test-key") {
				t.Fatalf("leaked response or key: %v", err)
			}
			if command.Cleanup != nil || len(command.Args) != 0 {
				t.Fatal("modified command on failure")
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
