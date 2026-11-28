// Package tracetest helps test the agents' session readers.
package tracetest

import (
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// Summaries names each item briefly, in order.
func Summaries(items []agents.Item) []string {
	summaries := make([]string, len(items))
	for i, item := range items {
		switch item["type"] {
		case "message":
			summaries[i] = item["role"].(string) + ":" + item["content"].([]agents.Item)[0]["text"].(string)
		case "reasoning":
			summaries[i] = "reasoning"
		case "tool_call":
			summaries[i] = "call:" + item["callId"].(string)
		case "tool_result":
			summaries[i] = "result:" + item["callId"].(string) + "=" + item["output"].(string)
		}
	}
	return summaries
}

// Time parses an RFC 3339 time.
func Time(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
