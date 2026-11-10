package cli

import (
	"context"
	"time"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/selfupdate"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		root.AddCommand(newUpdateCmd(gf))
	})
}

func newUpdateCmd(gf *globalFlags) *cobra.Command {
	var (
		checkOnly bool
		force     bool
	)
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update the dari CLI to the latest release.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if checkOnly {
				ctx, cancel := context.WithTimeout(cmd.Context(), 10*time.Second)
				defer cancel()
				release, err := selfupdate.NewClient(gf.version).Latest(ctx)
				if err != nil {
					return err
				}
				return printJSON(map[string]any{
					"current_version":  gf.version,
					"latest_version":   release.Version,
					"update_available": selfupdate.IsReleaseVersion(gf.version) && selfupdate.IsNewerVersion(release.Version, gf.version),
					"release_url":      nilIfEmpty(release.URL),
				})
			}

			ctx, cancel := context.WithTimeout(cmd.Context(), 5*time.Minute)
			defer cancel()
			result, err := selfupdate.Update(ctx, gf.version, selfupdate.UpdateOptions{
				Force:  force,
				Stdout: cmd.OutOrStdout(),
				Stderr: cmd.ErrOrStderr(),
			})
			if err != nil {
				return err
			}
			return printJSON(result)
		},
	}
	cmd.Flags().BoolVar(&checkOnly, "check", false, "Check for an available update without installing it")
	cmd.Flags().BoolVar(&force, "force", false, "Reinstall the latest release even when this version is current")
	return cmd
}
