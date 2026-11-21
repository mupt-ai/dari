package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeCodexRouter serves a router's model list as the gateway does: to the
// Dari CLI (which reads the nulls), and to Codex itself (client_version),
// marked when this router can serve Codex its own list.
type fakeCodexRouter struct {
	mu     sync.Mutex
	models []string
	direct bool
	key    string
	// failCodexFetch makes the request Codex itself sends fail.
	failCodexFetch bool
}

func (f *fakeCodexRouter) set(models []string, direct bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.models, f.direct = models, direct
}

func (f *fakeCodexRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path != "/v1/models" {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+f.key {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"invalid_api_key","message":"bad key"}}`))
		return
	}
	if f.failCodexFetch && r.URL.Query().Get("client_version") != "" {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	body := map[string]any{"remote_compaction": "unsupported"}
	entries := []map[string]any{}
	for _, slug := range f.models {
		entries = append(entries, map[string]any{"slug": slug, "web_search_tool_type": "text"})
	}
	body["models"] = entries
	if f.direct && r.URL.Query().Get("client_version") != "" {
		body["codex_direct"] = true
	}
	_ = json.NewEncoder(w).Encode(body)
}

func codexTestHome(t *testing.T) string {
	t.Helper()
	setGatewayEnv(t, "http://gateway.test")
	home := filepath.Join(os.Getenv("HOME"), ".codex")
	t.Setenv("CODEX_HOME", home)
	return home
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

// A setup on a router that serves Codex its own list names the URL; a later
// --refresh re-reads the router and makes every open Codex re-read it too.
func TestCodexRefreshOnALiveList(t *testing.T) {
	home := codexTestHome(t)
	router := &fakeCodexRouter{models: []string{"dari/routing", "dari/model/a/one"}, direct: true, key: "k"}
	server := httptest.NewServer(router)
	defer server.Close()

	models, err := routerModels(context.Background(), server.URL, "k", "codex")
	if err != nil {
		t.Fatal(err)
	}
	if err := saveAgentConfig(context.Background(), "codex", "k", server.URL, models); err != nil {
		t.Fatal(err)
	}
	config := readFile(t, filepath.Join(home, "config.toml"))
	if !strings.Contains(config, `model_catalog_url = "`+server.URL+`/v1/models"`) || strings.Contains(config, "model_catalog_json") {
		t.Fatalf("setup did not name the live list:\n%s", config)
	}
	if _, err := os.Stat(filepath.Join(home, "dari-models.json")); !os.IsNotExist(err) {
		t.Fatalf("setup wrote a copy too: %v", err)
	}

	// The router gains a model; Codex has a saved list from before.
	router.set([]string{"dari/routing", "dari/model/a/one", "dari/model/a/two"}, true)
	if err := os.WriteFile(filepath.Join(home, "models_cache.json"), []byte(`{"models":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	if err := runCodexRefresh(context.Background(), &stderr); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "models_cache.json")); !os.IsNotExist(err) {
		t.Fatalf("Codex's saved list was kept: %v", err)
	}
	out := stderr.String()
	if !strings.Contains(out, "dari/model/a/two") || !strings.Contains(out, "open /model again") || strings.Contains(out, "daemon restart") {
		t.Fatalf("refresh said:\n%s", out)
	}
}

// A setup from before this change wrote a copy; --refresh on a router that
// can serve the live list moves it there and says the background server must
// restart once.
func TestCodexRefreshMovesACopyToTheLiveList(t *testing.T) {
	home := codexTestHome(t)
	router := &fakeCodexRouter{models: []string{"dari/routing", "dari/model/a/one"}, direct: false, key: "k"}
	server := httptest.NewServer(router)
	defer server.Close()
	models, err := routerModels(context.Background(), server.URL, "k", "codex")
	if err != nil {
		t.Fatal(err)
	}
	if err := saveAgentConfig(context.Background(), "codex", "k", server.URL, models); err != nil {
		t.Fatal(err)
	}
	if config := readFile(t, filepath.Join(home, "config.toml")); !strings.Contains(config, "model_catalog_json") {
		t.Fatalf("an older gateway should get a copy:\n%s", config)
	}

	router.set([]string{"dari/routing", "dari/model/a/one"}, true)
	var stderr bytes.Buffer
	if err := runCodexRefresh(context.Background(), &stderr); err != nil {
		t.Fatal(err)
	}
	config := readFile(t, filepath.Join(home, "config.toml"))
	if strings.Contains(config, "model_catalog_json") || !strings.Contains(config, "model_catalog_url") {
		t.Fatalf("refresh did not move to the live list:\n%s", config)
	}
	if !strings.Contains(stderr.String(), "codex app-server daemon restart") {
		t.Fatalf("refresh did not say to restart the background server:\n%s", stderr.String())
	}
}

// Still an older gateway: the copy is rewritten with the router's models.
func TestCodexRefreshRewritesTheCopyOnAnOlderGateway(t *testing.T) {
	home := codexTestHome(t)
	router := &fakeCodexRouter{models: []string{"dari/routing"}, key: "k"}
	server := httptest.NewServer(router)
	defer server.Close()
	models, _ := routerModels(context.Background(), server.URL, "k", "codex")
	if err := saveAgentConfig(context.Background(), "codex", "k", server.URL, models); err != nil {
		t.Fatal(err)
	}
	router.set([]string{"dari/routing", "dari/model/a/two"}, false)
	var stderr bytes.Buffer
	if err := runCodexRefresh(context.Background(), &stderr); err != nil {
		t.Fatal(err)
	}
	if copy := readFile(t, filepath.Join(home, "dari-models.json")); !strings.Contains(copy, "dari/model/a/two") {
		t.Fatalf("copy not rewritten:\n%s", copy)
	}
	if !strings.Contains(stderr.String(), "new Codex windows show it") {
		t.Fatalf("refresh said:\n%s", stderr.String())
	}
}

// The pick Codex saved is kept while the router still has it, and named
// when the router dropped it.
func TestCodexRefreshKeepsOrReportsTheSavedPick(t *testing.T) {
	home := codexTestHome(t)
	router := &fakeCodexRouter{models: []string{"dari/routing", "dari/model/a/one", "dari/model/a/two"}, direct: true, key: "k"}
	server := httptest.NewServer(router)
	defer server.Close()
	models, _ := routerModels(context.Background(), server.URL, "k", "codex")
	if err := saveAgentConfig(context.Background(), "codex", "k", server.URL, models); err != nil {
		t.Fatal(err)
	}
	// What Codex's /model leaves in the config.
	path := filepath.Join(home, "config.toml")
	config := strings.Replace(readFile(t, path), `model = "dari/routing"`, `model = "dari/model/a/two"`, 1)
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	var stderr bytes.Buffer
	if err := runCodexRefresh(context.Background(), &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(readFile(t, path), `model = "dari/model/a/two"`) {
		t.Fatal("refresh dropped a pick the router still serves")
	}

	router.set([]string{"dari/routing", "dari/model/a/one"}, true)
	stderr.Reset()
	if err := runCodexRefresh(context.Background(), &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(readFile(t, path), `model = "dari/routing"`) {
		t.Fatalf("refresh kept a pick the router dropped:\n%s", readFile(t, path))
	}
	if !strings.Contains(stderr.String(), "no longer serves dari/model/a/two") {
		t.Fatalf("refresh did not report the dropped pick:\n%s", stderr.String())
	}
}

// A key the router no longer accepts (rotated) is reported, and nothing is
// rewritten; without a setup there is nothing to refresh.
func TestCodexRefreshWithARefusedKeyOrNoSetup(t *testing.T) {
	home := codexTestHome(t)
	var stderr bytes.Buffer
	if err := runCodexRefresh(context.Background(), &stderr); err != nil || !strings.Contains(stderr.String(), "Dari is not set up in Codex") {
		t.Fatalf("no setup: %v, %q", err, stderr.String())
	}

	router := &fakeCodexRouter{models: []string{"dari/routing"}, direct: true, key: "old"}
	server := httptest.NewServer(router)
	defer server.Close()
	models, _ := routerModels(context.Background(), server.URL, "old", "codex")
	if err := saveAgentConfig(context.Background(), "codex", "old", server.URL, models); err != nil {
		t.Fatal(err)
	}
	before := readFile(t, filepath.Join(home, "config.toml"))
	router.key = "new"
	err := runCodexRefresh(context.Background(), &stderr)
	if err == nil || !strings.Contains(err.Error(), "dari setup codex --cli") {
		t.Fatalf("refused key: %v", err)
	}
	if after := readFile(t, filepath.Join(home, "config.toml")); after != before {
		t.Fatal("a refused key changed the config")
	}
}

// A check of the live list that fails (a timeout, a 5xx) must not turn a live
// setup back into a copy: refresh fails and the config is left as it was.
func TestCodexRefreshKeepsALiveSetupWhenTheCheckFails(t *testing.T) {
	home := codexTestHome(t)
	router := &fakeCodexRouter{models: []string{"dari/routing", "dari/model/a/one"}, direct: true, key: "k"}
	server := httptest.NewServer(router)
	defer server.Close()
	models, _ := routerModels(context.Background(), server.URL, "k", "codex")
	if err := saveAgentConfig(context.Background(), "codex", "k", server.URL, models); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "config.toml")
	before := readFile(t, path)

	router.mu.Lock()
	router.failCodexFetch = true
	router.mu.Unlock()
	var stderr bytes.Buffer
	if err := runCodexRefresh(context.Background(), &stderr); err == nil {
		t.Fatal("refresh succeeded although the live list could not be checked")
	}
	if after := readFile(t, path); after != before {
		t.Fatalf("a failed check changed the config:\n%s", after)
	}
	if _, err := os.Stat(filepath.Join(home, "dari-models.json")); !os.IsNotExist(err) {
		t.Fatalf("a failed check wrote a copy: %v", err)
	}
}
