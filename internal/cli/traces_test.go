package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// useAgentHomes points every agent's session storage at a temporary home
// holding the synthetic transcripts each agent's package tests with.
func useAgentHomes(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	write := func(fixture string, path ...string) {
		content, err := os.ReadFile(fixture)
		if err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(append([]string{home}, path...)...)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join("agents", "claude", "testdata", "transcript.jsonl"), "claude", "projects", "-work", "sess-claude.jsonl")
	write(filepath.Join("agents", "claude", "testdata", "subagent.jsonl"), "claude", "projects", "-work", "sess-claude", "subagents", "agent-a.jsonl")
	write(filepath.Join("agents", "codex", "testdata", "rollout.jsonl"), "codex", "sessions", "2026", "03", "02", "rollout-2026-03-02-sess-codex.jsonl")
	write(filepath.Join("agents", "codex", "testdata", "routed-rollout.jsonl"), "codex", "sessions", "2026", "03", "02", "rollout-2026-03-02-sess-routed.jsonl")
	write(filepath.Join("agents", "pi", "testdata", "session.jsonl"), "pi", "sessions", "--work--", "2026-03-02_sess-pi.jsonl")
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, "claude"))
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Join(home, "pi"))
	// No OpenCode database lives here.
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
}

func runTracesImport(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := newRootCmd("dev")
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(append([]string{"traces", "import"}, args...))
	err := cmd.Execute()
	return out.String(), err
}

func TestTracesImportDryRunCountsEachAgent(t *testing.T) {
	useAgentHomes(t)
	// A dry run reads no credentials and sends nothing.
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	out, err := runTracesImport(t, "--dry-run")
	if err != nil {
		t.Fatal(err)
	}
	want := "" +
		"Agent         Sessions     Turns\n" +
		"Claude Code          1         4\n" +
		"Codex                1         3\n" +
		"Pi                   1         3\n"
	if out != want {
		t.Errorf("output =\n%s\nwant\n%s", out, want)
	}

	out, err = runTracesImport(t, "--dry-run", "--agent", "claude", "--since", "2026-03-03T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if want := "Agent         Sessions     Turns\nClaude Code          1         1\n"; out != want {
		t.Errorf("output since =\n%s\nwant\n%s", out, want)
	}

	if _, err := runTracesImport(t, "--dry-run", "--agent", "opencode"); err == nil || !strings.Contains(err.Error(), "no OpenCode sessions at") {
		t.Errorf("missing agent error = %v", err)
	}
	if _, err := runTracesImport(t, "--dry-run", "--agent", "cursor"); err == nil || !strings.Contains(err.Error(), "expected claude, codex, opencode, pi") {
		t.Errorf("unknown agent error = %v", err)
	}
	if _, err := runTracesImport(t, "--dry-run", "--since", "last week"); err == nil || !strings.Contains(err.Error(), "invalid --since") {
		t.Errorf("bad since error = %v", err)
	}
}

func TestTracesImportUploadsEachSession(t *testing.T) {
	useAgentHomes(t)
	var uploaded []agents.Session
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/organizations/current/routing/activity/imports" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer dari_test" {
			t.Errorf("Authorization = %q", got)
		}
		var session agents.Session
		if err := json.NewDecoder(r.Body).Decode(&session); err != nil {
			t.Error(err)
		}
		uploaded = append(uploaded, session)
		// The subagent's call was imported by an earlier run.
		imported := len(session.Turns)
		if session.AgentID != "" {
			imported = 0
		}
		_ = json.NewEncoder(w).Encode(map[string]int{"imported": imported, "existing": len(session.Turns) - imported})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	out, err := runTracesImport(t, "--api-url", srv.URL, "--agent", "claude")
	if err != nil {
		t.Fatal(err)
	}
	want := "" +
		"Agent         Sessions     Turns  Imported\n" +
		"Claude Code          1         4         3\n"
	if out != want {
		t.Errorf("output =\n%s\nwant\n%s", out, want)
	}
	// One request per context window and per subagent thread, each with the
	// conversation up to its last call.
	if len(uploaded) != 3 {
		t.Fatalf("uploads = %d, want 3", len(uploaded))
	}
	for _, session := range uploaded {
		last := session.Turns[len(session.Turns)-1]
		if session.Agent != "claude" || session.SessionID != "sess-claude" || len(session.Items) != last.InputItems+last.OutputItems {
			t.Errorf("upload = %+v", session)
		}
	}
}

func TestImportSessionRequestsBoundsEachRequest(t *testing.T) {
	session := agents.Session{Agent: "pi", SessionID: "sess"}
	for i := 0; i < importTurnsPerRequest+5; i++ {
		session.Items = append(session.Items, agents.MessageItem("user", "next"), agents.MessageItem("assistant", "ok"))
		session.Turns = append(session.Turns, agents.Turn{InputItems: 2*i + 1, OutputItems: 1})
	}
	// The last call's conversation is too large for one request.
	session.Items = append(session.Items, agents.MessageItem("user", strings.Repeat("x", importMaxRequestBytes)), agents.MessageItem("assistant", "ok"))
	session.Turns = append(session.Turns, agents.Turn{InputItems: len(session.Items) - 1, OutputItems: 1})

	var sent [][2]int
	imported, tooLarge, err := importSessionRequests(session, func(body []byte) (int, error) {
		var request agents.Session
		if err := json.Unmarshal(body, &request); err != nil {
			return 0, err
		}
		sent = append(sent, [2]int{len(request.Turns), len(request.Items)})
		return len(request.Turns), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if imported != importTurnsPerRequest+5 || tooLarge != 1 {
		t.Errorf("imported = %d, too large = %d", imported, tooLarge)
	}
	// 25 calls, then the 5 that fit one at a time once the oversized call
	// shares their request, and the oversized call itself is left out.
	want := [][2]int{{importTurnsPerRequest, 2 * importTurnsPerRequest}}
	for i := importTurnsPerRequest; i < importTurnsPerRequest+5; i++ {
		want = append(want, [2]int{1, 2 * (i + 1)})
	}
	if !reflect.DeepEqual(sent, want) {
		t.Errorf("requests = %v, want %v", sent, want)
	}
}
