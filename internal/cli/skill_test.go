package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestSkillFlagPrintsEmbeddedSkillWithoutAuthentication(t *testing.T) {
	cmd := newRootCmd("test")
	var output bytes.Buffer
	cmd.SetOut(&output)
	cmd.SetArgs([]string{"--skill"})

	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "# Dari Managed Routers") {
		t.Fatalf("skill output missing heading: %q", output.String()[:min(len(output.String()), 100)])
	}
}
