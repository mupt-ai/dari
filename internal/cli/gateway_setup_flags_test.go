package cli

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/pi"
	"github.com/mupt-ai/dari/internal/gateway"
)

// Agents set the routing mode with flags, not the menu, so each mode must
// save what the menu would save.
func TestGatewaySetupFromFlags(t *testing.T) {
	setGatewayEnv(t, "")
	ctx := context.Background()

	if err := setGatewayModeFromFlags(ctx, "local", "", "", "dari-key", strings.NewReader(""), io.Discard); err != nil {
		t.Fatal(err)
	}
	local, ok, err := gateway.Load()
	if err != nil || !ok || local.Mode != gateway.ModeLocal || local.LocalKey == "" || local.AutoRoutingKey != "dari-key" {
		t.Fatalf("local settings = %+v, %v, %v", local, ok, err)
	}
	// Re-running keeps the gateway key, so clients already configured still work.
	if err := setGatewayModeFromFlags(ctx, "local", "", "", "", strings.NewReader(""), io.Discard); err != nil {
		t.Fatal(err)
	}
	again, _, _ := gateway.Load()
	if again.LocalKey != local.LocalKey || again.AutoRoutingKey != "dari-key" {
		t.Fatalf("re-run changed settings: %+v", again)
	}

	if err := setGatewayModeFromFlags(ctx, "hosted", "", "", "", strings.NewReader(""), io.Discard); err != nil {
		t.Fatal(err)
	}
	if hosted, _, _ := gateway.Load(); hosted.Mode != gateway.ModeHosted {
		t.Fatalf("mode = %q, want hosted", hosted.Mode)
	}

	if err := setGatewayModeFromFlags(ctx, "self-hosted", "", "", "", strings.NewReader(""), io.Discard); err == nil {
		t.Fatal("self-hosted without --url and --key succeeded")
	}
	if err := setGatewayModeFromFlags(ctx, "bogus", "", "", "", strings.NewReader(""), io.Discard); err == nil {
		t.Fatal("unknown mode succeeded")
	}
}

// The local gateway's key and secrets survive a switch to another mode and
// back, so agents set up with the key and saved API keys keep working.
func TestGatewayModeSwitchKeepsLocalSecrets(t *testing.T) {
	setGatewayEnv(t, "")
	ctx := context.Background()
	self := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(gatewayCatalog))
	}))
	defer self.Close()

	if err := gateway.Save(gateway.Settings{
		Mode: gateway.ModeLocal, LocalKey: "local-key", AutoRoutingKey: "dari-key",
		ProviderKeys: map[string]string{"DEEPSEEK_API_KEY": "ds-key"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := setGatewayModeFromFlags(ctx, "hosted", "", "", "", strings.NewReader(""), io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := setGatewayModeFromFlags(ctx, "self-hosted", self.URL, "team-key", "", strings.NewReader(""), io.Discard); err != nil {
		t.Fatal(err)
	}
	selfHosted, _, _ := gateway.Load()
	if selfHosted.Mode != gateway.ModeSelfHosted || selfHosted.Key != "team-key" || selfHosted.AutoRoutingKey != "dari-key" {
		t.Fatalf("self-hosted settings = %+v", selfHosted)
	}
	if err := setGatewayModeFromFlags(ctx, "local", "", "", "", strings.NewReader(""), io.Discard); err != nil {
		t.Fatal(err)
	}
	local, _, _ := gateway.Load()
	if local.AutoRoutingKey != "dari-key" || local.ProviderKeys["DEEPSEEK_API_KEY"] != "ds-key" {
		t.Fatalf("local secrets lost: %+v", local)
	}
	if local.LocalKey != "local-key" {
		t.Fatalf("local key = %q, want the original local-key", local.LocalKey)
	}
	// The self-hosted gateway is remembered for switching back, but only
	// self-hosted mode routes through it.
	if local.URL != self.URL || local.Key != "team-key" {
		t.Fatalf("self-hosted gateway forgotten: %+v", local)
	}
	if gw, err := currentGateway(); err != nil || gw == nil || !gw.local {
		t.Fatalf("local mode routes through %+v, %v", gw, err)
	}
	// The team's key belongs to the self-hosted gateway only.
	if selfHosted.LocalKey != "local-key" || local.Key == "local-key" {
		t.Fatalf("keys crossed: self-hosted %+v, local %+v", selfHosted, local)
	}
}

// A switch moves agents already set up, so running them directly follows the
// new mode without another `dari <agent>` launch.
func TestGatewayModeSwitchMovesSetUpAgents(t *testing.T) {
	setGatewayEnv(t, "")
	ctx := context.Background()
	self := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(gatewayCatalog))
	}))
	defer self.Close()
	dir, err := pi.AgentDir()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pi.Setup(dir, "https://routing.dari.dev", "hosted-key", agents.Models{Enabled: []string{"openai/gpt-4.1-mini"}}); err != nil {
		t.Fatal(err)
	}

	if err := setGatewayModeFromFlags(ctx, "self-hosted", self.URL, "team-key", "", strings.NewReader(""), io.Discard); err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(filepath.Join(dir, "dari.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), self.URL) || strings.Contains(string(config), "routing.dari.dev") {
		t.Fatalf("pi still routes the old way: %s", config)
	}
}

// Moving agents to hosted Dari needs a sign-in, which a switch never starts.
func TestGatewayModeSwitchToHostedWithoutSignInLeavesAgents(t *testing.T) {
	setGatewayEnv(t, "")
	hostedAPIMustNotBeCalled(t)
	dir, err := pi.AgentDir()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pi.Setup(dir, "http://gateway.test:8080", "team-key", agents.Models{Enabled: []string{"openai/gpt-4.1-mini"}}); err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	if err := setGatewayModeFromFlags(context.Background(), "hosted", "", "", "", strings.NewReader(""), &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr.String(), "after you sign in") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}
