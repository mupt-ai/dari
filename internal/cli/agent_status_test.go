package cli

import (
	"strings"
	"testing"
)

func TestAgentStatusCommand(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--headers", `{"x-dari-selected-model":"m","x-dari-thinking-level":"high","x-dari-lease-turns-remaining":"1"}`}, "m · high · lease 2 turns left"},
		{[]string{"--headers", `{"x-dari-selected-model":"m","x-dari-thinking-level":"high","x-dari-session-pinned":"true"}`}, "m · high · pinned"},
		{[]string{"--headers", `{"x-dari-selected-model":"m","x-request-id":"req_1"}`}, "m · https://app.dari.dev/activity/conversations/req_1"},
		{[]string{"--headers", `{"x-dari-thinking-level":"high"}`}, ""},
	} {
		root := newRootCmd("test")
		root.SetArgs(append([]string{"agent-status"}, tc.args...))
		var output strings.Builder
		root.SetOut(&output)
		if err := root.Execute(); err != nil {
			t.Fatal(err)
		}
		if got := strings.TrimSpace(output.String()); got != tc.want {
			t.Errorf("%q: got %q, want %q", tc.args, got, tc.want)
		}
	}
}
