package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/cli/agents/claude"
	"github.com/mupt-ai/dari/internal/cli/agents/codex"
	"github.com/mupt-ai/dari/internal/cli/agents/pi"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		traces := &cobra.Command{Use: "traces", Short: "Work with coding agent session traces"}
		traces.AddCommand(newTracesImportCmd(gf))
		root.AddCommand(traces)
	})
}

const (
	// A request carries a session's conversation once and this many of its
	// model calls, each stored with the conversation up to it.
	importTurnsPerRequest = 25
	// Hosted Dari's request size limit is 32 MiB.
	importMaxRequestBytes = 24 << 20
	importRequestTimeout  = 5 * time.Minute
)

// A traceSource is one coding agent's local session storage.
type traceSource struct {
	agent string
	label string
	// path is where the agent keeps its sessions.
	path func() (string, error)
	// sessions reads the sessions with model calls at or after since.
	sessions func(path string, since time.Time, visit func(importSession) error) error
}

var traceSources = []traceSource{
	{
		agent: "claude", label: "Claude Code",
		path: func() (string, error) {
			settings, err := claude.SettingsPath()
			return filepath.Join(filepath.Dir(settings), "projects"), err
		},
		sessions: transcriptFiles(parseClaudeTranscript, "*.jsonl"),
	},
	{
		agent: "codex", label: "Codex",
		path: func() (string, error) {
			home, err := codex.Home()
			return filepath.Join(home, "sessions"), err
		},
		sessions: transcriptFiles(parseCodexRollout, "rollout-*.jsonl"),
	},
	{
		agent: "opencode", label: "OpenCode",
		path: func() (string, error) {
			data := os.Getenv("XDG_DATA_HOME")
			if data == "" {
				home, err := os.UserHomeDir()
				if err != nil {
					return "", fmt.Errorf("find home directory: %w", err)
				}
				data = filepath.Join(home, ".local", "share")
			}
			return filepath.Join(data, "opencode", "opencode.db"), nil
		},
		sessions: openCodeSessions,
	},
	{
		agent: "pi", label: "Pi",
		path: func() (string, error) {
			dir, err := pi.AgentDir()
			return filepath.Join(dir, "sessions"), err
		},
		sessions: transcriptFiles(parsePiSession, "*.jsonl"),
	},
}

// transcriptFiles reads every transcript under a directory whose name matches
// and that changed since the cutoff.
func transcriptFiles(parse func(path string, since time.Time) ([]importSession, error), pattern string) func(string, time.Time, func(importSession) error) error {
	return func(root string, since time.Time, visit func(importSession) error) error {
		return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			if matched, _ := filepath.Match(pattern, entry.Name()); !matched {
				return nil
			}
			if info, err := entry.Info(); err != nil || info.ModTime().Before(since) {
				return err
			}
			sessions, err := parse(path, since)
			if err != nil {
				return fmt.Errorf("read %s: %w", path, err)
			}
			for _, session := range sessions {
				if err := visit(session); err != nil {
					return err
				}
			}
			return nil
		})
	}
}

// openCodeSessions reads OpenCode's SQLite database through the sqlite3
// command, which keeps a database driver out of the CLI.
func openCodeSessions(path string, since time.Time, visit func(importSession) error) error {
	sqlite, err := exec.LookPath("sqlite3")
	if err != nil {
		return errors.New("reading OpenCode sessions needs the sqlite3 command")
	}
	output, err := exec.Command(sqlite, "-readonly", "-json", path,
		"select session_id, id, type, data from session_message order by session_id, seq").Output()
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	var messages []openCodeMessage
	if len(output) > 0 {
		if err := json.Unmarshal(output, &messages); err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
	}
	for _, session := range parseOpenCodeMessages(messages, since) {
		if err := visit(session); err != nil {
			return err
		}
	}
	return nil
}

func newTracesImportCmd(gf *globalFlags) *cobra.Command {
	var agent, since string
	var dryRun bool
	cmd := &cobra.Command{
		Use:   "import",
		Short: "Import local coding agent sessions into Activity",
		Long: "Import the sessions Claude Code, Codex, OpenCode, and Pi keep on this machine, so they appear as conversations in Activity under a router named Imported. " +
			"Requests Dari already routed are skipped, token counts are kept without costs, and nothing is billed. Importing again adds only what is new.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cutoff, err := parseImportSince(since)
			if err != nil {
				return err
			}
			sources, err := selectedTraceSources(agent)
			if err != nil {
				return err
			}
			// send posts one request and answers how many of its model calls
			// were new. A dry run sends nothing.
			var send func(body []byte) (int, error)
			if !dryRun {
				client, err := currentActivityClient(cmd, gf)
				if err != nil {
					return err
				}
				client.HTTP = &http.Client{Timeout: importRequestTimeout}
				send = func(body []byte) (int, error) {
					var response struct {
						Imported int `json:"imported"`
					}
					err := client.Do(cmd.Context(), http.MethodPost, "/v1/organizations/current/routing/activity/imports", json.RawMessage(body), &response)
					return response.Imported, err
				}
			}
			out, stderr := cmd.OutOrStdout(), cmd.ErrOrStderr()
			progress := !dryRun && agentInputIsTerminal(stderr)
			header := []any{"Agent", "Sessions", "Turns"}
			format := "%-12s %9v %9v\n"
			if !dryRun {
				header, format = append(header, "Imported"), "%-12s %9v %9v %9v\n"
			}
			fmt.Fprintf(out, format, header...)
			var tooLarge int
			for _, source := range sources {
				sessions := map[string]bool{}
				var turns, imported int
				var uploadErr error
				err := source.sessions(source.root, cutoff, func(session importSession) error {
					sessions[session.SessionID] = true
					turns += len(session.Turns)
					if dryRun {
						return nil
					}
					var added, skipped int
					added, skipped, uploadErr = importSessionRequests(session, send)
					imported += added
					tooLarge += skipped
					if progress {
						fmt.Fprintf(stderr, "\r%s: %d turns", source.label, turns)
					}
					return uploadErr
				})
				if progress {
					fmt.Fprint(stderr, "\r\033[K")
				}
				if err != nil {
					// With no --agent, an agent that cannot be read is skipped.
					if agent != "" || uploadErr != nil {
						return err
					}
					fmt.Fprintf(stderr, "Skipped %s: %v\n", source.label, err)
					continue
				}
				row := []any{source.label, len(sessions), turns}
				if !dryRun {
					row = append(row, imported)
				}
				fmt.Fprintf(out, format, row...)
			}
			if tooLarge > 0 {
				fmt.Fprintf(stderr, "Left out %d turns whose conversations are too large to upload.\n", tooLarge)
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&agent, "agent", "", "Import one agent's sessions: claude, codex, opencode, or pi (default: every agent found)")
	f.StringVar(&since, "since", "", "Import only requests made on or after this date (YYYY-MM-DD or RFC3339)")
	f.BoolVar(&dryRun, "dry-run", false, "Count what would be imported without uploading")
	return cmd
}

type selectedTraceSource struct {
	traceSource
	root string
}

// selectedTraceSources is the named agent's storage, or every agent's that
// exists on this machine.
func selectedTraceSources(agent string) ([]selectedTraceSource, error) {
	var selected []selectedTraceSource
	var known []string
	for _, source := range traceSources {
		known = append(known, source.agent)
		if agent != "" && agent != source.agent {
			continue
		}
		root, err := source.path()
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(root); err != nil {
			if agent != "" {
				return nil, fmt.Errorf("no %s sessions at %s", source.label, root)
			}
			continue
		}
		selected = append(selected, selectedTraceSource{source, root})
	}
	if agent != "" && len(selected) == 0 {
		return nil, fmt.Errorf("invalid --agent %q: expected %s", agent, strings.Join(known, ", "))
	}
	return selected, nil
}

func parseImportSince(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, nil
	}
	if day, err := time.ParseInLocation(time.DateOnly, value, time.Local); err == nil {
		return day, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid --since %q: expected YYYY-MM-DD or an RFC3339 timestamp", value)
	}
	return parsed, nil
}

// importSessionRequests sends a session's model calls a few at a time, each
// request with the conversation up to its last call. It answers how many
// calls were new, and how many were left out because their conversation is
// too large for one request.
func importSessionRequests(session importSession, send func(body []byte) (int, error)) (imported, tooLarge int, err error) {
	for start := 0; start < len(session.Turns); {
		end := min(start+importTurnsPerRequest, len(session.Turns))
		for {
			last := session.Turns[end-1]
			request := session
			request.Turns = session.Turns[start:end]
			request.Items = session.Items[:last.InputItems+last.OutputItems]
			body, err := json.Marshal(request)
			if err != nil {
				return imported, tooLarge, fmt.Errorf("encode session %s: %w", session.SessionID, err)
			}
			if len(body) <= importMaxRequestBytes {
				added, err := send(body)
				imported += added
				if err != nil {
					return imported, tooLarge, err
				}
				break
			}
			if end-start == 1 {
				tooLarge++
				break
			}
			end = start + 1
		}
		start = end
	}
	return imported, tooLarge, nil
}
