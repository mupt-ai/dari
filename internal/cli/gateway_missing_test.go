package cli

import (
	"slices"
	"strings"
	"testing"
)

// What a missing gateway model needs depends on the agent: a Claude
// subscription serves only Claude Code, OpenCode Go serves any agent, and
// only a local gateway's API keys are the CLI's to add.
func TestGatewayMissingModelsSayWhatToConnect(t *testing.T) {
	offered := []gatewayModelConfig{
		{ID: "anthropic/claude-opus-5-5"},
		{ID: "deepseek-ai/DeepSeek-V4.1-Flash-1017", Provider: "opencode-go"},
		{ID: "openai/gpt-6.2-sol"},
	}
	for _, tc := range []struct {
		agent string
		local bool
		want  []string
	}{
		{"claude", true, []string{
			"Not available yet: anthropic/claude-opus-5-5. To use: connect Claude Code (`dari accounts subscription connect claude-code`) or add an Anthropic key (`dari accounts key anthropic <key>`).",
			"Not available yet: deepseek-ai/DeepSeek-V4.1-Flash-1017. To use: connect OpenCode Go (`dari accounts subscription connect opencode-go`) or add an OpenCode Go key (`dari accounts key opencode-go <key>`).",
		}},
		{"opencode", true, []string{
			"Not available yet: anthropic/claude-opus-5-5. To use: add an Anthropic key (`dari accounts key anthropic <key>`).",
			"Not available yet: deepseek-ai/DeepSeek-V4.1-Flash-1017. To use: connect OpenCode Go (`dari accounts subscription connect opencode-go`) or add an OpenCode Go key (`dari accounts key opencode-go <key>`).",
		}},
		{"opencode", false, []string{
			"Not available yet: anthropic/claude-opus-5-5. To use: set ANTHROPIC_API_KEY on the gateway.",
			"Not available yet: deepseek-ai/DeepSeek-V4.1-Flash-1017. To use: connect OpenCode Go (`dari accounts subscription connect opencode-go`) or set OPENCODE_API_KEY on the gateway.",
		}},
	} {
		missing := gatewayMissingModels(&gatewayConfig{local: tc.local}, tc.agent, offered, []string{"openai/gpt-6.2-sol"})
		if got := gatewayMissingLines(missing); !slices.Equal(got, tc.want) {
			t.Errorf("%s (local %v):\n%s\nwant\n%s", tc.agent, tc.local, strings.Join(got, "\n"), strings.Join(tc.want, "\n"))
		}
	}
}
