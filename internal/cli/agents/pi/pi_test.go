package pi

import (
	"github.com/mupt-ai/dari/internal/cli/agents"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// A launch points the extension Setup installed at this launch's router; Pi
// loads it from its extensions directory, so no --extension is passed.
func TestConfigurePointsTheInstalledExtensionAtTheRouter(t *testing.T) {
	t.Setenv("PI_CODING_AGENT_DIR", t.TempDir())
	if _, err := Setup(os.Getenv("PI_CODING_AGENT_DIR"), "https://routing.test", "dak_1", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	command := agents.Command{Path: "/pi", Args: []string{"-p", "review"}, Env: []string{agents.RoutingAPIKeyEnv + "=dari_route"}}
	if err := Configure(&command, "https://routing.test/rtr_1", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	if command.Cleanup != nil {
		t.Fatal("Pi command should not need cleanup")
	}
	if got := agents.EnvironmentValue(command.Env, "DARI_ROUTING_BASE_URL"); got != "https://routing.test/rtr_1" {
		t.Fatalf("DARI_ROUTING_BASE_URL = %q", got)
	}
	if agents.EnvironmentValue(command.Env, "DARI_STATUS_EXECUTABLE") == "" {
		t.Error("no status executable")
	}
	if slices.Contains(command.Args, "--extension") {
		t.Fatalf("args = %q: the installed extension loads on its own", command.Args)
	}
}

// A launch whose extension is not installed (setup skipped or failed) brings
// its own copy, so --provider dari always has a provider.
func TestConfigureBringsTheExtensionWhenItIsNotInstalled(t *testing.T) {
	t.Setenv("PI_CODING_AGENT_DIR", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	command := agents.Command{Path: "/pi"}
	if err := Configure(&command, "https://routing.test", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	index := slices.Index(command.Args, "--extension")
	if index < 0 {
		t.Fatalf("args = %q, want the launch's own extension", command.Args)
	}
	if data, err := os.ReadFile(command.Args[index+1]); err != nil || string(data) != extension {
		t.Fatalf("extension at %s: %v", command.Args[index+1], err)
	}
}

// Setup installs the provider extension where Pi loads extensions, and saves
// what `pi` run directly needs beside Pi's settings; the extension itself
// holds no key.
func TestSetupInstallsTheProviderExtension(t *testing.T) {
	dir := t.TempDir()
	if _, err := Setup(dir, "https://routing.test", "dak_1", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "extensions", "dari.ts"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if content != extension {
		t.Error("installed extension differs from agents/pi/extension.ts")
	}
	for _, want := range []string{
		`pi.registerProvider("dari"`,
		`pi.on("after_provider_response"`,
		`reasoning: id !== "dari/routing"`,
		`x-dari-selected-model`,
		`"agent-status", "--headers"`,
		`ctx.ui.setStatus("dari"`,
		`process.env.DARI_STATUS_EXECUTABLE ?? saved.statusExecutable`,
		"baseUrl: `${routingBaseURL}/v1`",
		`process.env.DARI_ROUTING_BASE_URL ?? saved.baseUrl ?? "https://routing.dari.dev"`,
		`revision === expectedRevision`,
	} {
		if !strings.Contains(content, want) {
			t.Errorf("extension is missing %s", want)
		}
	}
	if strings.Contains(content, "dak_1") {
		t.Fatal("extension contains the key")
	}
	saved, err := readJSON(filepath.Join(dir, "dari.json"))
	if err != nil || saved["apiKey"] != "dak_1" || saved["baseUrl"] != "https://routing.test" {
		t.Fatalf("dari.json = %v, %v", saved, err)
	}
	if info, err := os.Stat(filepath.Join(dir, "dari.json")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("dari.json mode = %v, %v", info.Mode(), err)
	}
}

// Every launch makes Dari Pi's default; Pi's own settings come back on removal.
func TestSetupRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"defaultProvider":"anthropic","defaultModel":"claude-sonnet","theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models := agents.Models{Enabled: []string{"a/one", "a/two"}}
	first, err := Setup(dir, "https://routing.test", "dak_1", models)
	if err != nil || !first {
		t.Fatalf("first setup = %v, %v", first, err)
	}
	settings, _ := readJSON(filepath.Join(dir, "settings.json"))
	if settings["defaultProvider"] != "dari" || settings["defaultModel"] != "dari/model/a/one" || settings["theme"] != "dark" {
		t.Fatalf("settings = %v", settings)
	}
	// Pi's /model saved another Dari model; the next launch keeps it.
	settings["defaultModel"] = "dari/model/a/two"
	if err := writeJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	if got := SavedModel(dir); got != "dari/model/a/two" {
		t.Fatalf("SavedModel = %q", got)
	}
	models.Saved = SavedModel(dir)
	if first, err := Setup(dir, "http://127.0.0.1:7340", "dgw", models); err != nil || first {
		t.Fatalf("second setup = %v, %v", first, err)
	}
	if settings, _ := readJSON(filepath.Join(dir, "settings.json")); settings["defaultModel"] != "dari/model/a/two" {
		t.Fatalf("settings = %v", settings)
	}

	removed, err := RemoveSetup(dir)
	if err != nil || !removed {
		t.Fatalf("remove = %v, %v", removed, err)
	}
	settings, _ = readJSON(filepath.Join(dir, "settings.json"))
	if settings["defaultProvider"] != "anthropic" || settings["defaultModel"] != "claude-sonnet" || settings["enabledModels"] != nil || settings["theme"] != "dark" {
		t.Fatalf("settings after remove = %v", settings)
	}
	for _, name := range []string{"extensions/dari.ts", "dari.json", "dari-setup.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s remains: %v", name, err)
		}
	}
	if SavedModel(dir) != "" {
		t.Error("another provider's default is not a Dari pick")
	}
}

// Settings Pi cannot parse stop setup before it writes the key anywhere.
func TestSetupWritesNothingOverUnreadableSettings(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"theme": "dark",}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Setup(dir, "https://routing.test", "dak_1", agents.Models{Enabled: []string{"a/one"}}); err == nil {
		t.Fatal("setup over unparseable settings succeeded")
	}
	for _, name := range []string{"extensions/dari.ts", "dari.json", "dari-setup.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s written: %v", name, err)
		}
	}
}

func TestPiScopesModelPickerToTheRouter(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// os.UserCacheDir prefers XDG_CACHE_HOME on Linux.
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	command := agents.Command{Path: "/pi"}
	if err := Configure(&command, "https://routing.dari.dev", agents.Models{Enabled: []string{"openai/gpt-6-luna", "anthropic/claude-sonnet-5-5"}}); err != nil {
		t.Fatal(err)
	}
	index := slices.Index(command.Args, "--models")
	if index < 0 || command.Args[index+1] != "dari/dari/model/openai/gpt-6-luna,dari/dari/model/anthropic/claude-sonnet-5-5" {
		t.Fatalf("args = %q, want the router's models scoped", command.Args)
	}

	// A scope the user chose stays theirs.
	command = agents.Command{Path: "/pi", Args: []string{"--models", "mine/*"}}
	if err := Configure(&command, "https://routing.dari.dev", agents.Models{Routing: true}); err != nil {
		t.Fatal(err)
	}
	if strings.Count(strings.Join(command.Args, " "), "--models") != 1 {
		t.Fatalf("args = %q, want the user's --models only", command.Args)
	}
}
