package cli

// Commits linked to the agent sessions that made them. `dari claude` and
// `dari codex` install a post-commit hook in the repository they start in,
// and Claude Code's prompt hook (`dari agent-hook --claude`) notes its
// session in the worktree's git directory. After each commit the hook reports
// the commit for the session that made it: the agent's own session when an
// agent commits (its environment names it), or else each session noted in
// this worktree in the last day. Activity links the session to the pull
// request on the commit's branch. Only GitHub repositories are reported.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/state"
)

const (
	commitHookMarker   = "# dari: links commits to Dari agent sessions"
	linkCommitsConfig  = "dari.linkCommits"
	activeSessionsFile = "dari-sessions.json"
	// A session noted this recently is credited with a commit made by hand.
	activeSessionWindow = 24 * time.Hour
	maxActiveSessions   = 20
	gitHookTimeout      = 10 * time.Second
)

// pendingSessionRetries are the waits before reporting again a commit whose
// session the gateway cannot place yet: a Codex subagent can commit before
// the request that ran the command is recorded, which the gateway does after
// each response. They span most of the hook's ten minutes; the last try
// files the commit regardless.
var pendingSessionRetries = []time.Duration{15 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute}

var errSessionPending = errors.New("session not recorded yet")

// activeSession is an agent session noted in a worktree. KeyDigest names the
// key its requests used without storing the key in the repository.
type activeSession struct {
	Harness   string    `json:"harness"`
	SessionID string    `json:"session_id"`
	BaseURL   string    `json:"base_url"`
	KeyDigest string    `json:"key_digest"`
	SeenAt    time.Time `json:"seen_at"`
}

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, _ *globalFlags) {
		gitHook := &cobra.Command{
			Use:   "git-hook",
			Short: "Link this repository's commits to your Dari agent sessions",
			Long: "`dari claude` and `dari codex` install a post-commit hook that reports each commit for the agent " +
				"session that made it, so Activity links the session to the pull request on the commit's branch.",
		}
		gitHook.AddCommand(&cobra.Command{
			Use:   "install",
			Short: "Install the post-commit hook in this repository",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				if _, err := git(cmd.Context(), ".", "config", "--local", "--unset", linkCommitsConfig); err != nil && !isGitExit(err, 5) {
					return err
				}
				hook, err := installCommitHook(cmd.Context(), ".")
				if err != nil {
					return err
				}
				if hook == hookSkipped {
					return errors.New("this repository's hooks are managed elsewhere (core.hooksPath or a post-commit hook that is not a shell script); run `dari git-hook post-commit &` from your post-commit hook")
				}
				fmt.Fprintln(cmd.OutOrStdout(), "Commits in this repository now link to your Dari agent sessions.")
				return nil
			},
		})
		gitHook.AddCommand(&cobra.Command{
			Use:   "remove",
			Short: "Remove the post-commit hook and stop installing it in this repository",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				if _, err := git(cmd.Context(), ".", "config", "--local", linkCommitsConfig, "false"); err != nil {
					return err
				}
				if err := removeCommitHook(cmd.Context(), "."); err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), "Commits in this repository no longer link to Dari agent sessions.")
				return nil
			},
		})
		gitHook.AddCommand(&cobra.Command{
			Use:    "post-commit",
			Short:  "Report the commit just made for the agent sessions that made it",
			Hidden: true,
			Args:   cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				ctx, cancel := context.WithTimeout(cmd.Context(), 10*time.Minute)
				defer cancel()
				return reportCommit(ctx, ".", time.Now())
			},
		})
		root.AddCommand(gitHook)

		var fromClaude bool
		agentHook := &cobra.Command{
			Use:    "agent-hook",
			Short:  "Note a coding agent's session in its repository",
			Hidden: true,
			Args:   cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				// A prompt hook must never block or print: its output joins the prompt.
				if fromClaude {
					_ = noteClaudeSession(cmd.Context(), cmd.InOrStdin(), time.Now())
				}
				return nil
			},
		}
		agentHook.Flags().BoolVar(&fromClaude, "claude", false, "Read Claude Code hook input from stdin")
		root.AddCommand(agentHook)
	})
}

// linkAgentCommits installs the post-commit hook in the repository a launch
// starts in, unless the repository opted out. It says so the first time.
func linkAgentCommits(ctx context.Context, stderr io.Writer) {
	if hook, err := installCommitHook(ctx, "."); err == nil && hook == hookAdded {
		agentStep(stderr, "Commits in this repository now link to your Dari sessions; `dari git-hook remove` stops it")
	}
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	output, err := command.Output()
	return strings.TrimSpace(string(output)), err
}

func isGitExit(err error, code int) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == code
}

var shellShebang = regexp.MustCompile(`^#!\s*\S*/(?:env\s+)?(?:sh|bash|zsh|dash)\b`)

type hookState int

const (
	hookSkipped hookState = iota
	hookPresent
	hookAdded
)

// installCommitHook adds the hook line to the repository's post-commit hook,
// creating it if needed. It leaves alone a directory outside a repository and
// a repository that opted out, keeps its hooks elsewhere (core.hooksPath), or
// has a post-commit hook that is not a shell script.
func installCommitHook(ctx context.Context, dir string) (hookState, error) {
	if _, err := git(ctx, dir, "rev-parse", "--git-dir"); err != nil {
		return hookSkipped, nil
	}
	if value, _ := git(ctx, dir, "config", "--get", linkCommitsConfig); value == "false" {
		return hookSkipped, nil
	}
	if value, _ := git(ctx, dir, "config", "--get", "core.hooksPath"); value != "" {
		return hookSkipped, nil
	}
	hooks, err := git(ctx, dir, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
	if err != nil {
		return hookSkipped, err
	}
	executable, err := agents.StatusExecutable()
	if err != nil {
		return hookSkipped, err
	}
	line := agents.ShellQuote(executable) + " git-hook post-commit >/dev/null 2>&1 </dev/null & " + commitHookMarker
	path := filepath.Join(hooks, "post-commit")
	existing, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(hooks, 0o755); err != nil {
			return hookSkipped, err
		}
		return hookAdded, os.WriteFile(path, []byte("#!/bin/sh\n"+line+"\n"), 0o755)
	}
	if err != nil {
		return hookSkipped, err
	}
	lines := strings.Split(string(existing), "\n")
	if at := slices.IndexFunc(lines, isCommitHookLine); at >= 0 {
		if lines[at] == line {
			return hookPresent, nil
		}
		// Dari moved; point the hook at it.
		lines[at] = line
		return hookPresent, writeKeepingMode(path, strings.Join(lines, "\n"))
	}
	if !shellShebang.MatchString(lines[0]) {
		return hookSkipped, nil
	}
	// Right after the shebang, so an `exit` later in the hook cannot skip it.
	lines = slices.Insert(lines, 1, line)
	return hookAdded, writeKeepingMode(path, strings.Join(lines, "\n"))
}

func isCommitHookLine(line string) bool { return strings.HasSuffix(line, commitHookMarker) }

func removeCommitHook(ctx context.Context, dir string) error {
	hooks, err := git(ctx, dir, "rev-parse", "--path-format=absolute", "--git-path", "hooks")
	if err != nil {
		return err
	}
	path := filepath.Join(hooks, "post-commit")
	existing, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	lines := slices.DeleteFunc(strings.Split(string(existing), "\n"), isCommitHookLine)
	if strings.TrimSpace(strings.Join(lines, "\n")) == "#!/bin/sh" {
		return os.Remove(path)
	}
	return writeKeepingMode(path, strings.Join(lines, "\n"))
}

func writeKeepingMode(path, content string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), info.Mode().Perm())
}

func keyDigest(key string) string {
	digest := sha256.Sum256([]byte(key))
	return hex.EncodeToString(digest[:8])
}

// noteClaudeSession records the session behind a Claude Code prompt in its
// worktree's git directory, when it routes through Dari from a repository.
func noteClaudeSession(ctx context.Context, input io.Reader, now time.Time) error {
	var hook struct {
		SessionID string `json:"session_id"`
		Cwd       string `json:"cwd"`
	}
	if err := json.NewDecoder(io.LimitReader(input, 1<<20)).Decode(&hook); err != nil {
		return err
	}
	key, baseURL := os.Getenv(agents.RoutingAPIKeyEnv), os.Getenv(agents.RoutingBaseURLEnv)
	if hook.SessionID == "" || hook.Cwd == "" || key == "" || baseURL == "" {
		return nil
	}
	gitDir, err := git(ctx, hook.Cwd, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return nil
	}
	path := filepath.Join(gitDir, activeSessionsFile)
	sessions := readActiveSessions(path)
	sessions = slices.DeleteFunc(sessions, func(s activeSession) bool {
		return s.SessionID == hook.SessionID || now.Sub(s.SeenAt) > activeSessionWindow
	})
	sessions = append(sessions, activeSession{
		Harness: "claude_code", SessionID: hook.SessionID, BaseURL: baseURL, KeyDigest: keyDigest(key), SeenAt: now.UTC(),
	})
	if len(sessions) > maxActiveSessions {
		sessions = sessions[len(sessions)-maxActiveSessions:]
	}
	data, err := json.Marshal(map[string]any{"sessions": sessions})
	if err != nil {
		return err
	}
	// Written whole and renamed, so a hook reading it never sees half.
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func readActiveSessions(path string) []activeSession {
	var file struct {
		Sessions []activeSession `json:"sessions"`
	}
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &file) != nil {
		return nil
	}
	return file.Sessions
}

// commitSession is a session to report a commit for, with the key to report it with.
type commitSession struct {
	harness, sessionID, baseURL, key string
}

// commitSessions are the sessions that made the commit: the agent whose shell
// ran `git commit`, or else those noted in this worktree within the window
// whose key this machine still has.
func commitSessions(ctx context.Context, dir string, now time.Time) []commitSession {
	key, baseURL := os.Getenv(agents.RoutingAPIKeyEnv), os.Getenv(agents.RoutingBaseURLEnv)
	if key != "" && baseURL != "" {
		// The agent's session ID in its own shell commands' environment.
		for _, agent := range agentList {
			if agent.SessionEnv == "" {
				continue
			}
			if id := os.Getenv(agent.SessionEnv); id != "" {
				return []commitSession{{agent.CodingAgent, id, baseURL, key}}
			}
		}
	}
	gitDir, err := git(ctx, dir, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return nil
	}
	keys := map[string]string{}
	candidates, _ := state.CachedRoutingKeys()
	if gw, err := currentGateway(); err == nil && gw != nil {
		candidates = append(candidates, gw.key)
	}
	if key != "" {
		candidates = append(candidates, key)
	}
	for _, candidate := range candidates {
		keys[keyDigest(candidate)] = candidate
	}
	var sessions []commitSession
	for _, noted := range readActiveSessions(filepath.Join(gitDir, activeSessionsFile)) {
		if key, ok := keys[noted.KeyDigest]; ok && now.Sub(noted.SeenAt) <= activeSessionWindow {
			sessions = append(sessions, commitSession{noted.Harness, noted.SessionID, noted.BaseURL, key})
		}
	}
	return sessions
}

var githubRemote = regexp.MustCompile(`^(?:https://(?:[^@/]+@)?github\.com/|(?:ssh://)?git@github\.com[:/])([\w.-]+)/([\w.-]+?)(?:\.git)?/?$`)

// githubRepository is the remote's GitHub `owner/name`, or "" for any other remote.
func githubRepository(remote string) string {
	match := githubRemote.FindStringSubmatch(strings.TrimSpace(remote))
	if match == nil {
		return ""
	}
	return strings.ToLower(match[1] + "/" + match[2])
}

type reportedCommit struct {
	Repository  string `json:"repository"`
	Branch      string `json:"branch"`
	SHA         string `json:"sha"`
	PullRequest *int   `json:"pull_request,omitempty"`
	Title       string `json:"title,omitempty"`
}

// reportCommit reports HEAD for the sessions that made it. A detached HEAD or
// a branch whose remote is not on GitHub has nothing to link.
func reportCommit(ctx context.Context, dir string, now time.Time) error {
	branch, err := git(ctx, dir, "symbolic-ref", "--short", "-q", "HEAD")
	if err != nil || branch == "" {
		return nil
	}
	remote, _ := git(ctx, dir, "config", "--get", "branch."+branch+".remote")
	if remote == "" {
		remote = "origin"
	}
	url, err := git(ctx, dir, "remote", "get-url", remote)
	if err != nil {
		return nil
	}
	repository := githubRepository(url)
	if repository == "" {
		return nil
	}
	sessions := commitSessions(ctx, dir, now)
	if len(sessions) == 0 {
		return nil
	}
	sha, err := git(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	commit := reportedCommit{Repository: repository, Branch: branch, SHA: sha}
	commit.PullRequest, commit.Title = openPullRequest(ctx, dir, branch)
	var failed []error
	for _, session := range sessions {
		if err := sendCommitUntilPlaced(ctx, session, commit); err != nil {
			failed = append(failed, err)
		}
	}
	return errors.Join(failed...)
}

// openPullRequest is the branch's open pull request, when the GitHub CLI is
// installed and signed in. Commits on a branch whose pull request no agent
// opened still link to it.
func openPullRequest(ctx context.Context, dir, branch string) (*int, string) {
	if _, err := exec.LookPath("gh"); err != nil {
		return nil, ""
	}
	ctx, cancel := context.WithTimeout(ctx, gitHookTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "gh", "pr", "view", "--json", "number,title,state,headRefName")
	command.Dir = dir
	output, err := command.Output()
	if err != nil {
		return nil, ""
	}
	var pr struct {
		Number      int    `json:"number"`
		Title       string `json:"title"`
		State       string `json:"state"`
		HeadRefName string `json:"headRefName"`
	}
	if json.Unmarshal(output, &pr) != nil || pr.State != "OPEN" || pr.HeadRefName != branch || pr.Number < 1 {
		return nil, ""
	}
	return &pr.Number, pr.Title
}

func sendCommitUntilPlaced(ctx context.Context, session commitSession, commit reportedCommit) error {
	for _, wait := range pendingSessionRetries {
		if err := sendCommit(ctx, session, commit, false); !errors.Is(err, errSessionPending) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
	return sendCommit(ctx, session, commit, true)
}

func sendCommit(ctx context.Context, session commitSession, commit reportedCommit, final bool) error {
	body, err := json.Marshal(map[string]any{
		"harness":    session.harness,
		"session_id": session.sessionID,
		"commits":    []reportedCommit{commit},
		"final":      final,
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, gitHookTimeout)
	defer cancel()
	url := strings.TrimSuffix(session.baseURL, "/") + "/v1/dari/git-events"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+session.key)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		return errSessionPending
	}
	if response.StatusCode >= 300 {
		return fmt.Errorf("report commit to %s: %s", url, response.Status)
	}
	return nil
}
