package cli

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/claude"
)

// agent-status renders the routing status line for agents that shell out to
// Dari: Claude Code's status line, and the Pi and OpenCode integrations.
func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, _ *globalFlags) {
		var fromClaude bool
		var headersJSON string
		command := &cobra.Command{
			Use:    "agent-status",
			Short:  "Render coding-agent routing status",
			Hidden: true,
			Args:   cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				var status agents.Status
				if fromClaude {
					// Status hooks must stay quiet before the transcript exists or while it
					// contains an incomplete line. Errors must not replace the agent's UI.
					status, _ = claude.TranscriptStatus(cmd.InOrStdin())
				} else {
					var values map[string]string
					if err := json.Unmarshal([]byte(headersJSON), &values); err != nil {
						return err
					}
					headers := make(http.Header, len(values))
					for name, value := range values {
						headers.Set(name, value)
					}
					status = agents.StatusFromHeaders(headers)
				}
				if text := status.String(); text != "" {
					fmt.Fprintln(cmd.OutOrStdout(), text)
				}
				return nil
			},
		}
		command.Flags().BoolVar(&fromClaude, "claude", false, "Read Claude Code status input from stdin")
		command.Flags().StringVar(&headersJSON, "headers", "{}", "Routing response headers as JSON")
		root.AddCommand(command)
	})
}
