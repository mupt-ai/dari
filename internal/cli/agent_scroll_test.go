package cli

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestScrollToFocusKeepsTheFocusAndHints(t *testing.T) {
	page := []string{}
	for i := range 20 {
		page = append(page, fmt.Sprint(i))
	}
	page[15] += agentFocusMark
	page = append(page, "hints")
	shown := scrollToFocus(page, 10)
	if len(shown) != 10 || shown[len(shown)-1] != "hints" {
		t.Fatalf("shown = %q", shown)
	}
	plain := []string{}
	for _, line := range shown {
		plain = append(plain, strings.ReplaceAll(stripANSI(line), agentFocusMark, ""))
	}
	if !slices.Contains(plain, "15") || !strings.Contains(plain[0], "↑ more") || !strings.Contains(plain[len(plain)-2], "↓ more") {
		t.Fatalf("shown = %q", plain)
	}
	// A page that fits is left alone.
	if got := scrollToFocus(page[:5], 10); len(got) != 5 {
		t.Fatalf("short page = %q", got)
	}
}
