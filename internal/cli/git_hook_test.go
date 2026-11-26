package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/state"
)

// Agent launches under test must not install a hook in the repository the
// tests run in, so every test runs as if it had opted out; the tests below
// opt back in for their own repositories.
func TestMain(m *testing.M) {
	os.Setenv("GIT_CONFIG_COUNT", "1")
	os.Setenv("GIT_CONFIG_KEY_0", linkCommitsConfig)
	os.Setenv("GIT_CONFIG_VALUE_0", "false")
	// No test reaches the real gateway on this computer.
	launchGateway = func(context.Context, string, io.Writer) *gatewayConfig { return nil }
	computerClient = func(context.Context, io.Reader, io.Writer, bool) (*api.Client, error) {
		return nil, errors.New("tests never start this computer's gateway")
	}
	os.Exit(m.Run())
}

// testRepository is a repository on branch fix whose origin is on GitHub,
// with one commit, isolated from the user's git configuration.
func testRepository(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_COUNT", "0")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	dir := t.TempDir()
	runGit(t, dir, "init", "-q", "-b", "fix")
	runGit(t, dir, "remote", "add", "origin", "git@github.com:Acme/Web.git")
	runGit(t, dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "fix")
	return dir
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	output, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func TestCommitHookInstallsOnceAndRemoves(t *testing.T) {
	dir := testRepository(t)
	ctx := context.Background()
	hook := filepath.Join(dir, ".git", "hooks", "post-commit")

	if state, err := installCommitHook(ctx, dir); err != nil || state != hookAdded {
		t.Fatalf("install = %v, %v", state, err)
	}
	if state, err := installCommitHook(ctx, dir); err != nil || state != hookPresent {
		t.Fatalf("second install = %v, %v", state, err)
	}
	content, _ := os.ReadFile(hook)
	if info, _ := os.Stat(hook); !strings.HasPrefix(string(content), "#!/bin/sh\n") ||
		!strings.Contains(string(content), " git-hook post-commit ") || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("hook = %q", content)
	}

	if err := removeCommitHook(ctx, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(hook); !os.IsNotExist(err) {
		t.Fatalf("hook left behind: %v", err)
	}
	// Removal is remembered, so the next launch leaves the repository alone.
	runGit(t, dir, "config", "--local", linkCommitsConfig, "false")
	if state, _ := installCommitHook(ctx, dir); state != hookSkipped {
		t.Fatalf("install after opting out = %v", state)
	}
}

func TestCommitHookJoinsAShellHookAndLeavesOthersAlone(t *testing.T) {
	dir := testRepository(t)
	ctx := context.Background()
	hook := filepath.Join(dir, ".git", "hooks", "post-commit")

	// Before the hook's own commands, so its `exit` cannot skip the report.
	os.WriteFile(hook, []byte("#!/usr/bin/env bash\nnotify-team\nexit 0\n"), 0o755)
	if state, err := installCommitHook(ctx, dir); err != nil || state != hookAdded {
		t.Fatalf("install = %v, %v", state, err)
	}
	lines := strings.Split(string(must(os.ReadFile(hook))), "\n")
	if len(lines) != 5 || !isCommitHookLine(lines[1]) || lines[2] != "notify-team" {
		t.Fatalf("hook = %q", lines)
	}
	if err := removeCommitHook(ctx, dir); err != nil {
		t.Fatal(err)
	}
	if got := string(must(os.ReadFile(hook))); got != "#!/usr/bin/env bash\nnotify-team\nexit 0\n" {
		t.Fatalf("hook after removal = %q", got)
	}

	os.WriteFile(hook, []byte("#!/usr/bin/env node\nrun()\n"), 0o755)
	if state, _ := installCommitHook(ctx, dir); state != hookSkipped {
		t.Fatalf("install into a node hook = %v", state)
	}
	os.Remove(hook)
	runGit(t, dir, "config", "core.hooksPath", ".husky")
	if state, _ := installCommitHook(ctx, dir); state != hookSkipped {
		t.Fatalf("install with core.hooksPath = %v", state)
	}
}

// reportedCommits serves the gateway's commit endpoint and records what it got.
func reportedCommits(t *testing.T) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	var received []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var report map[string]any
		json.Unmarshal(body, &report)
		report["path"], report["authorization"] = r.URL.Path, r.Header.Get("Authorization")
		received = append(received, report)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	// No GitHub CLI: the hook asks it for the branch's pull request.
	t.Setenv("PATH", filepath.Dir(must(exec.LookPath("git"))))
	return server, &received
}

func TestAnAgentsCommitIsReportedForItsSession(t *testing.T) {
	dir := testRepository(t)
	server, received := reportedCommits(t)
	t.Setenv("DARI_ROUTING_API_KEY", "dgw_agent")
	t.Setenv("DARI_ROUTING_BASE_URL", server.URL+"/rtr_1")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "")
	t.Setenv("CODEX_THREAD_ID", "019a0000-0000-7000-8000-000000000001")

	if err := reportCommit(context.Background(), dir, time.Now()); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"final":         false,
		"path":          "/rtr_1/v1/dari/git-events",
		"authorization": "Bearer dgw_agent",
		"harness":       "codex",
		"session_id":    "019a0000-0000-7000-8000-000000000001",
		"commits": []any{map[string]any{
			"repository": "acme/web", "branch": "fix", "sha": runGit(t, dir, "rev-parse", "HEAD"),
		}},
	}
	if len(*received) != 1 || !jsonEqual((*received)[0], want) {
		t.Fatalf("reported %v, want %v", *received, want)
	}
}

func TestACommitByHandIsReportedForTheSessionsNotedInItsWorktree(t *testing.T) {
	dir := testRepository(t)
	server, received := reportedCommits(t)
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	if _, _, err := state.EnsureRoutingKey("test", func() (string, error) { return "dgw_cached", nil }); err != nil {
		t.Fatal(err)
	}
	noted := time.Now()
	t.Setenv("DARI_ROUTING_API_KEY", "dgw_cached")
	t.Setenv("DARI_ROUTING_BASE_URL", server.URL)
	hookInput := `{"session_id":"8f0c2a4e-1b3d-4c5e-9f60-7a8b9c0d1e2f","cwd":"` + dir + `","hook_event_name":"UserPromptSubmit"}`
	if err := noteClaudeSession(context.Background(), strings.NewReader(hookInput), noted); err != nil {
		t.Fatal(err)
	}
	// A commit in a terminal: no agent environment.
	for _, name := range []string{"DARI_ROUTING_API_KEY", "DARI_ROUTING_BASE_URL", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"} {
		t.Setenv(name, "")
	}

	if err := reportCommit(context.Background(), dir, noted.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if len(*received) != 1 || (*received)[0]["session_id"] != "8f0c2a4e-1b3d-4c5e-9f60-7a8b9c0d1e2f" ||
		(*received)[0]["authorization"] != "Bearer dgw_cached" || (*received)[0]["harness"] != "claude_code" {
		t.Fatalf("reported %v", *received)
	}
	// A day later the session no longer gets the credit.
	if err := reportCommit(context.Background(), dir, noted.Add(25*time.Hour)); err != nil || len(*received) != 1 {
		t.Fatalf("reported %v after the window, %v", *received, err)
	}
}

// A Codex subagent can commit before the gateway has recorded any request of
// its thread; the hook asks again, and its last try files the commit anyway.
func TestACommitIsReportedAgainUntilTheGatewayPlacesItsSession(t *testing.T) {
	dir := testRepository(t)
	t.Setenv("PATH", filepath.Dir(must(exec.LookPath("git"))))
	var finals []bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var report struct{ Final bool }
		json.NewDecoder(r.Body).Decode(&report)
		finals = append(finals, report.Final)
		w.WriteHeader(http.StatusConflict)
	}))
	t.Cleanup(server.Close)
	previous := pendingSessionRetries
	pendingSessionRetries = []time.Duration{time.Millisecond, time.Millisecond}
	t.Cleanup(func() { pendingSessionRetries = previous })
	t.Setenv("DARI_ROUTING_API_KEY", "dgw_agent")
	t.Setenv("DARI_ROUTING_BASE_URL", server.URL)
	t.Setenv("CLAUDE_CODE_SESSION_ID", "")
	t.Setenv("CODEX_THREAD_ID", "019a0000-0000-7000-8000-000000000002")

	reportCommit(context.Background(), dir, time.Now())
	if want := []bool{false, false, true}; !slices.Equal(finals, want) {
		t.Fatalf("reports' final flags = %v, want %v", finals, want)
	}
}

func TestGitHubRepository(t *testing.T) {
	for remote, want := range map[string]string{
		"git@github.com:Acme/Web.git":           "acme/web",
		"https://github.com/acme/web":           "acme/web",
		"https://token@github.com/acme/web.git": "acme/web",
		"ssh://git@github.com/acme/web.git":     "acme/web",
		"git@gitlab.com:acme/web.git":           "",
	} {
		if got := githubRepository(remote); got != want {
			t.Errorf("githubRepository(%q) = %q, want %q", remote, got, want)
		}
	}
}

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

func jsonEqual(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}
