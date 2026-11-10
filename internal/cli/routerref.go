package cli

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// normalizeRouterID accepts either a raw rtr_... ID or a copied router endpoint
// such as https://routing.dari.dev/rtr_123/chat/completions.
func normalizeRouterID(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}

	if id, ok := routerIDFromReference(trimmed); ok {
		return id, nil
	}
	if strings.Contains(trimmed, "://") || strings.Contains(trimmed, "/") {
		return "", fmt.Errorf("router reference %q does not contain a router ID like rtr_...", trimmed)
	}
	return trimmed, nil
}

func routerIDFromReference(ref string) (string, bool) {
	path := ref
	if u, err := url.Parse(ref); err == nil && u.Scheme != "" && u.Host != "" {
		path = u.Path
	} else {
		path, _, _ = strings.Cut(path, "?")
		path, _, _ = strings.Cut(path, "#")
	}

	for _, segment := range strings.Split(path, "/") {
		segment = strings.TrimSpace(segment)
		if strings.HasPrefix(segment, "rtr_") {
			return segment, true
		}
	}
	return "", false
}

// confirm prints a yes/no prompt to stderr and reads a single line from stdin.
func confirm(prompt string) bool {
	fmt.Fprint(os.Stderr, prompt)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes"
}
