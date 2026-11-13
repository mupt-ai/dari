package cli

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/spf13/cobra"
)

const dreamerPath = "/v1/organizations/current/dreamer"

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		cmd := &cobra.Command{
			Use:   "dreamer",
			Short: "Manage your dreamer, a cloud sandbox that works for you on hosted Dari",
			Long: "Your dreamer is a cloud sandbox of your own. Its only credential is a Dari key that\n" +
				"routes model calls through your routers and subscriptions and reads your own\n" +
				"conversations; it can manage nothing. It stops after 30 idle minutes or 12 hours,\n" +
				"and a stopped dreamer starts fresh, keeping only the files in its home directory.\n\n" +
				"Hosted Dari only.",
		}
		cmd.AddCommand(
			dreamerCommand(gf, "status", "Show whether your dreamer is running", http.MethodGet, ""),
			dreamerCommand(gf, "start", "Start your dreamer, or show the one already running", http.MethodPost, "/start"),
			dreamerCommand(gf, "stop", "Stop your dreamer and revoke its key", http.MethodPost, "/stop"),
			newDreamerRunCmd(gf),
		)
		root.AddCommand(cmd)
	})
}

func dreamerCommand(gf *globalFlags, use, short, method, path string) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: short,
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := requireHostedDreamer(); err != nil {
				return err
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, method, dreamerPath+path, nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

func newDreamerRunCmd(gf *globalFlags) *cobra.Command {
	var timeout int
	cmd := &cobra.Command{
		Use:     "run [--timeout SECONDS] -- COMMAND",
		Short:   "Run a shell command in your running dreamer and print its output",
		Example: "  dari dreamer run -- 'claude -p \"Summarize my last conversation\" --model dari/routing'",
		Args:    cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := requireHostedDreamer(); err != nil {
				return err
			}
			var resp struct {
				ExitCode int    `json:"exit_code"`
				Output   string `json:"output"`
			}
			body := map[string]any{"command": strings.Join(args, " "), "timeout_seconds": timeout}
			if err := orgKeyRequest(cmd, gf, http.MethodPost, dreamerPath+"/run", body, &resp); err != nil {
				return err
			}
			fmt.Fprint(cmd.OutOrStdout(), resp.Output)
			if resp.ExitCode != 0 {
				return fmt.Errorf("the command exited with status %d", resp.ExitCode)
			}
			return nil
		},
	}
	cmd.Flags().IntVar(&timeout, "timeout", 120, "seconds to wait for the command, at most 600")
	cmd.Flags().SetInterspersed(false)
	return cmd
}

func requireHostedDreamer() error {
	gw, err := currentGateway()
	if err != nil {
		return err
	}
	if gw != nil {
		return errors.New("the dreamer runs on hosted Dari; switch with `dari gateway setup --mode hosted`")
	}
	return nil
}
