package cli

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/gateway"
)

// private shows or sets this computer's private mode: on, none of its
// requests reach Activity, whichever plan or Dari serves them. Only a gateway
// connected to hosted Dari syncs Activity, so only it has the switch.
func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, _ *globalFlags) {
		root.AddCommand(&cobra.Command{
			Use:       "private [on|off]",
			Short:     "Show or set whether this computer's requests stay out of Activity",
			Args:      cobra.MatchAll(cobra.MaximumNArgs(1), cobra.OnlyValidArgs),
			ValidArgs: []string{"on", "off"},
			RunE: func(cmd *cobra.Command, args []string) error {
				settings, ok, err := gateway.Load()
				if err != nil {
					return err
				}
				if ok && settings.Mode != gateway.ModeHosted {
					const note = "Private mode doesn't apply to a local or self-hosted gateway: its Activity already stays on that gateway."
					if len(args) == 0 {
						fmt.Fprintln(cmd.OutOrStdout(), note)
						return nil
					}
					return errors.New(note)
				}
				client, err := computerClient(cmd.Context(), cmd.InOrStdin(), cmd.ErrOrStderr(), false)
				if err != nil {
					return err
				}
				var mode struct {
					Private bool `json:"private"`
				}
				if len(args) == 0 {
					err = client.Do(cmd.Context(), http.MethodGet, "/v1/gateway/private", nil, &mode)
				} else {
					err = client.Do(cmd.Context(), http.MethodPut, "/v1/gateway/private", map[string]bool{"private": args[0] == "on"}, &mode)
				}
				if err != nil {
					return api.HumanError(err)
				}
				if mode.Private {
					fmt.Fprintln(cmd.OutOrStdout(), "Private mode is on: this computer's requests stay out of Activity.")
				} else {
					fmt.Fprintln(cmd.OutOrStdout(), "Private mode is off: this computer's requests show in Activity.")
				}
				return nil
			},
		})
	})
}
