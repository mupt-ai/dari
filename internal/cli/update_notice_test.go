package cli

import (
	"testing"

	"github.com/spf13/cobra"
)

func TestShouldSkipUpdateNoticeForShellCompletion(t *testing.T) {
	for _, use := range []string{"__complete", "__completeNoDesc"} {
		root := &cobra.Command{Use: "dari"}
		cmd := &cobra.Command{Use: use}
		root.AddCommand(cmd)

		if !shouldSkipUpdateNotice(cmd) {
			t.Fatalf("shouldSkipUpdateNotice(%q) = false, want true", use)
		}
	}
}

func TestShouldSkipUpdateNoticeAllowsNormalCommands(t *testing.T) {
	root := &cobra.Command{Use: "dari"}
	cmd := &cobra.Command{Use: "session"}
	root.AddCommand(cmd)

	if shouldSkipUpdateNotice(cmd) {
		t.Fatal("shouldSkipUpdateNotice(normal command) = true, want false")
	}
}
