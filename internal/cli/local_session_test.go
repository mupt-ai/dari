package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLocalHarnessLaunchSyntax(t *testing.T) {
	for _, name := range agentNames() {
		for _, tc := range []struct {
			args   []string
			model  string
			native []string
		}{
			{[]string{"--local", "inkling-2-mini", "--", "--model"}, "inkling-2-mini", []string{"--", "--model"}},
			{[]string{"mcp", "add", "--local"}, "", []string{"mcp", "add", "--local"}},
			{[]string{"--", "--local", "inkling-2-mini"}, "", []string{"--", "--local", "inkling-2-mini"}},
			{[]string{"--include-local", "--", "--model"}, "", []string{"--", "--model"}},
			{[]string{"mcp", "--include-local"}, "", []string{"mcp", "--include-local"}},
			{[]string{}, "", []string{}},
		} {
			l, ok := parseAgentLaunch(append([]string{name}, tc.args...))
			wantPicker := len(tc.args) > 0 && tc.args[0] == "--include-local"
			if !ok || l.includeLocal != wantPicker || l.localModel != tc.model || !reflect.DeepEqual(l.args, tc.native) {
				t.Errorf("%s %v: got %+v", name, tc.args, l)
			}
		}
	}
}

// An unreachable, incompatible or redirecting listener must never silently
// turn an explicit local session into a hosted launch.
func TestLocalEngineBorrowsOnlyRequestedModel(t *testing.T) {
	var requested atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("unexpected %s", r.URL.Path)
		}
		requested.Add(1)
		fmt.Fprint(w, `{"data":[{"id":"installed","context_window":12345}]}`)
	}))
	defer server.Close()
	t.Setenv("DARI_INFERENCE_PORT", strings.Split(server.URL, ":")[2])
	t.Setenv("DARI_INFERENCE_SOURCE", t.TempDir())
	s := localSession{dir: t.TempDir()}
	base, window, err := s.engine(context.Background(), agentLaunch{localModel: "installed"}, io.Discard)
	if base != server.URL || window != 12345 || err != nil {
		t.Fatalf("borrow: %s %d %v", base, window, err)
	}
	s.close()
	if _, _, err = s.engine(context.Background(), agentLaunch{localModel: "missing"}, io.Discard); err == nil || !strings.Contains(err.Error(), "dari pull missing") {
		t.Fatalf("mismatched model: %v", err)
	}
	if requested.Load() != 2 {
		t.Fatal("borrowed engine did not survive session teardown")
	}
}
