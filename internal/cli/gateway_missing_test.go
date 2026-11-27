package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// gatewayMissingCatalog is what a gateway's /v1/canonical-models says serves
// these models: Anthropic's own, and for open-weights models every provider
// and gateway the catalog runs them on.
var gatewayMissingCatalog = map[string][]string{
	"anthropic/claude-opus-5-5": {"anthropic"},
	"moonshotai/Kimi-K3.1-Pro":  {"fireworks", "opencode-go", "vercel-token-pass", "openrouter", "vercel-ai-gateway"},
	"zai-org/GLM-5.3":           {"fireworks", "opencode-go", "vercel-token-pass", "openrouter", "vercel-ai-gateway"},
	"meta/muse-spark-open":      {"fireworks", "openrouter", "vercel-ai-gateway"},
}

// What a missing gateway model needs depends on the agent: a Claude
// subscription serves only Claude Code, OpenCode Go serves any agent, and
// only a local gateway's API keys are the CLI's to add. An open-weights
// model is served by every plan and key the catalog runs it on.
func TestGatewayMissingModelsSayWhatToConnect(t *testing.T) {
	offered := []gatewayModelConfig{
		{ID: "anthropic/claude-opus-5-5"},
		{ID: "deepseek-ai/DeepSeek-V4.1-Flash-1017", Provider: "opencode-go"},
		{ID: "openai/gpt-6.2-sol"},
		{ID: "moonshotai/Kimi-K3.1-Pro"},
		{ID: "zai-org/GLM-5.3"},
		{ID: "meta/muse-spark-open"},
		{ID: "acme/coder"},
	}
	const (
		connectGo   = "connect OpenCode Go (`dari accounts subscription connect opencode-go`)"
		connectPass = "connect Vercel Token Pass (`dari accounts subscription connect vercel-token-pass`)"
		addKeys     = "add a Fireworks, OpenRouter, or Vercel AI Gateway key (`dari accounts key <fireworks|openrouter|vercel-ai-gateway> <key>`)"
		setKeys     = "set FIREWORKS_API_KEY, OPENROUTER_API_KEY, or AI_GATEWAY_API_KEY on the gateway"
		unknown     = "Not available yet: acme/coder. To use: name who serves it with `provider:` in the router spec, or set acme's API key on the gateway."
	)
	for _, tc := range []struct {
		agent string
		local bool
		want  []string
	}{
		{"claude", true, []string{
			"Not available yet: anthropic/claude-opus-5-5. To use: connect Claude Code (`dari accounts subscription connect claude-code`) or add an Anthropic key (`dari accounts key anthropic <key>`).",
			"Not available yet: deepseek-ai/DeepSeek-V4.1-Flash-1017. To use: " + connectGo + ".",
			"Not available yet: moonshotai/Kimi-K3.1-Pro, zai-org/GLM-5.3. To use: " + connectGo + " or " + connectPass + " or " + addKeys + ".",
			"Not available yet: meta/muse-spark-open. To use: " + addKeys + ".",
			unknown,
		}},
		{"opencode", true, []string{
			"Not available yet: anthropic/claude-opus-5-5. To use: add an Anthropic key (`dari accounts key anthropic <key>`).",
			"Not available yet: deepseek-ai/DeepSeek-V4.1-Flash-1017. To use: " + connectGo + ".",
			"Not available yet: moonshotai/Kimi-K3.1-Pro, zai-org/GLM-5.3. To use: " + connectGo + " or " + connectPass + " or " + addKeys + ".",
			"Not available yet: meta/muse-spark-open. To use: " + addKeys + ".",
			unknown,
		}},
		{"opencode", false, []string{
			"Not available yet: anthropic/claude-opus-5-5. To use: set ANTHROPIC_API_KEY on the gateway.",
			"Not available yet: deepseek-ai/DeepSeek-V4.1-Flash-1017. To use: " + connectGo + ".",
			"Not available yet: moonshotai/Kimi-K3.1-Pro, zai-org/GLM-5.3. To use: " + connectGo + " or " + connectPass + " or " + setKeys + ".",
			"Not available yet: meta/muse-spark-open. To use: " + setKeys + ".",
			unknown,
		}},
	} {
		missing := gatewayMissingModels(&gatewayConfig{local: tc.local}, tc.agent, offered, []string{"openai/gpt-6.2-sol"}, gatewayMissingCatalog)
		if got := gatewayMissingLines(missing); !slices.Equal(got, tc.want) {
			t.Errorf("%s (local %v):\n%s\nwant\n%s", tc.agent, tc.local, strings.Join(got, "\n"), strings.Join(tc.want, "\n"))
		}
	}
}

// A missing Kimi on a local gateway offers the plans that run it, then the
// API keys, as the gateway's catalog reports them.
func TestGatewayMissingPageOffersEverySourceOfAnOpenWeightsModel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gw-key" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v1/router/models":
			_ = json.NewEncoder(w).Encode(gatewayModelLists{Models: []gatewayModelConfig{{ID: "anthropic/claude-opus-5-5"}, {ID: "moonshotai/Kimi-K3.1-Pro"}}, Chosen: true})
		case "/v1/canonical-models":
			data := []map[string]any{}
			for id, providers := range gatewayMissingCatalog {
				data = append(data, map[string]any{"id": id, "name": id, "thinking_levels": []string{}, "providers": providers})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	gw := &gatewayConfig{url: server.URL, key: "gw-key", local: true}
	_, missing, err := fetchGatewayMissing(context.Background(), gw, gw.url, "codex", []string{"anthropic/claude-opus-5-5"})
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 1 || missing[0].model != "moonshotai/Kimi-K3.1-Pro" {
		t.Fatalf("missing = %+v", missing)
	}
	var labels []string
	for _, source := range missing[0].sources() {
		labels = append(labels, source.label)
	}
	want := []string{"Connect OpenCode Go", "Connect Vercel Token Pass", "Add Fireworks Key", "Add OpenRouter Key", "Add Vercel AI Gateway Key", "Skip For Now"}
	if !slices.Equal(labels, want) {
		t.Errorf("sources = %q, want %q", labels, want)
	}
	if note := missing[0].note(); note != "Needs OpenCode Go or Vercel Token Pass or Fireworks, OpenRouter, or Vercel AI Gateway key" {
		t.Errorf("note = %q", note)
	}
}

// A Claude Code plan is not offered to another agent, and the page says why.
func TestGatewayMissingNoteNamesAgentOnlyPlans(t *testing.T) {
	missing := gatewayMissingModels(&gatewayConfig{local: true}, "codex", []gatewayModelConfig{{ID: "anthropic/claude-opus-5-5"}}, nil, gatewayMissingCatalog)
	if note := missing[0].note(); note != "Needs Anthropic key · Claude Code plans serve Claude Code only" {
		t.Errorf("note = %q", note)
	}
}
