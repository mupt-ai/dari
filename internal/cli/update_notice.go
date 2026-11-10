package cli

import (
	"strings"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/selfupdate"
)

func maybePrintUpdateNotice(cmd *cobra.Command, version string) {
	if shouldSkipUpdateNotice(cmd) {
		return
	}
	selfupdate.Notice(cmd.Context(), cmd.ErrOrStderr(), version)
}

func shouldSkipUpdateNotice(cmd *cobra.Command) bool {
	for c := cmd; c != nil; c = c.Parent() {
		name := strings.TrimSpace(c.Name())
		switch name {
		case "update", "completion", "help", "__complete", "__completeNoDesc":
			return true
		}
	}
	return false
}
