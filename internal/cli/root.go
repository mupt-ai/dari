// Package cli wires up the cobra command tree for the `dari` binary.
package cli

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/cli/agents/codex"
	"github.com/mupt-ai/dari/internal/state"
)

// Execute runs the root command. version is injected at build time via
// -ldflags -X main.version=...; an empty string is displayed as "dev".
func Execute(version string) int {
	if version != "" {
		cliVersion = version
	}
	if launch, ok := parseAgentLaunch(os.Args[1:]); ok {
		ctx := context.Background()
		if launch.name == "codex" || launch.name == "opencode" {
			// Ctrl-C belongs to the agent (interrupt turn / exit), not the
			// wrapper. Keep cleanup alive until its TUI exits.
			interrupts := make(chan os.Signal, 1)
			signal.Notify(interrupts, os.Interrupt)
			defer signal.Stop(interrupts)
			var cancel context.CancelFunc
			ctx, cancel = signal.NotifyContext(ctx, codex.ShutdownSignals()...)
			defer cancel()
		}
		return runAgentLaunch(
			ctx,
			launch,
			os.Stdin,
			os.Stdout,
			os.Stderr,
		)
	}

	root := newRootCmd(version)
	if err := root.Execute(); err != nil {
		// Cobra already prints the error — just return a non-zero exit.
		return 1
	}
	return 0
}

// cliVersion is this build's version, for release downloads.
var cliVersion = "dev"

// globalFlags hold cross-command options resolved at root level.
//
//go:embed skill/SKILL.md
var skillFile embed.FS

type globalFlags struct {
	apiURL  string
	version string
	skill   bool
}

func newRootCmd(version string) *cobra.Command {
	if version == "" {
		version = "dev"
	}
	gf := &globalFlags{version: version}
	cmd := &cobra.Command{
		Use:           "dari",
		Short:         "dari manages Dari routers, credentials, and organizations.",
		SilenceUsage:  true,
		SilenceErrors: false,
		Version:       version,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !gf.skill {
				return cmd.Help()
			}
			content, err := skillFile.ReadFile("skill/SKILL.md")
			if err != nil {
				return fmt.Errorf("read embedded skill: %w", err)
			}
			_, err = cmd.OutOrStdout().Write(content)
			return err
		},
	}
	cmd.SetVersionTemplate("dari {{.Version}}\n")

	cmd.PersistentFlags().StringVar(&gf.apiURL, "api-url", "", "Override the Dari API base URL (defaults to $DARI_API_URL or the cached value)")
	_ = cmd.PersistentFlags().MarkHidden("api-url")
	cmd.PersistentFlags().BoolVar(&gf.skill, "skill", false, "Print the Dari agent skill and exit")
	cmd.PersistentPreRun = func(cmd *cobra.Command, _ []string) {
		if gf.skill {
			return
		}
		maybePrintUpdateNotice(cmd, version)
	}

	// Subcommands are registered by their respective files via init().
	registerCommands(cmd, gf)
	return cmd
}

// commandRegistrars is the set of functions that append subcommands to the
// root. Each command file appends to this slice from its init().
var commandRegistrars []func(*cobra.Command, *globalFlags)

func registerCommands(root *cobra.Command, gf *globalFlags) {
	for _, fn := range commandRegistrars {
		fn(root, gf)
	}
}

// resolveAPIURL implements flag → env → state → default precedence.
// DARI_API_KEY mode skips cached browser-login state.
func (gf *globalFlags) resolveAPIURL() (string, error) {
	if v := strings.TrimSpace(gf.apiURL); v != "" {
		return api.NormalizeURL(v), nil
	}
	if v := strings.TrimSpace(os.Getenv("DARI_API_URL")); v != "" {
		return api.NormalizeURL(v), nil
	}
	if auth.EnvAPIKeyValue() != "" {
		return api.DefaultAPIURL, nil
	}
	s, err := state.Load()
	if err != nil {
		return "", err
	}
	if s.APIURL != "" {
		return api.NormalizeURL(s.APIURL), nil
	}
	return api.DefaultAPIURL, nil
}

// printJSON writes a pretty-printed JSON document to stdout, matching the
// Python CLI's `json.dumps(..., indent=2, sort_keys=True)` layout closely
// enough that consumers parsing stdout don't break. Go's encoder already
// sorts map keys alphabetically, so only indent setup is needed.
func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return fmt.Errorf("encode json: %w", err)
	}
	return nil
}

// orgKeyRequest issues a request authenticated with the current org API key.
// If DARI_API_KEY is set, that key is used instead of cached CLI state.
func orgKeyRequest(cmd *cobra.Command, gf *globalFlags, method, path string, body, out any) error {
	apiURL, err := gf.resolveAPIURL()
	if err != nil {
		return err
	}
	client, err := auth.OrgKeyClient(apiURL)
	if err != nil {
		return err
	}
	return client.Do(cmd.Context(), method, path, body, out)
}
