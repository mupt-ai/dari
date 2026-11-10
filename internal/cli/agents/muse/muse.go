// Package muse launches Muse Code through Dari. Muse Code reads its endpoint
// from its settings, so the launch pins a local proxy to the router there, and
// takes the routing key from META_API_KEY, which it prefers to its own
// sign-in. Interactive launches draw Dari's routing status under Muse Code's
// own status bar.
package muse

import (
	"strconv"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// Configure passes the routing key and starts Muse Code on the launch's
// default model.
func Configure(command *agents.Command, key string, models agents.Models) {
	command.Env = agents.WithEnvironment(command.Env, map[string]string{
		"META_API_KEY":        key,
		"MUSE_NO_AUTO_UPDATE": "1",
	})
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--model", models.Default()})
}

// Prepare points Muse Code at a local proxy to the router at baseURL, which
// forwards its model list and requests and reads routing status from each
// reply. Muse Code sends its bearer key only to a base URL that its settings
// name and pin to bearer auth, so both are set for the run. Interactive
// launches show that status on the terminal's last row.
func Prepare(command *agents.Command, launchArgs []string, key, baseURL string) error {
	bar := newStatusBar()
	proxy, err := newStatusProxy(key, baseURL, bar.set)
	if err != nil {
		return err
	}
	previousCleanup := command.Cleanup
	command.Cleanup = func() {
		proxy.close()
		if previousCleanup != nil {
			previousCleanup()
		}
	}
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{
		"-c", "endpoint_transport.base_url=" + strconv.Quote(proxy.url()+"/v1"),
		"-c", `endpoint_transport.auth="bearer"`,
	})
	if interactiveArgs(launchArgs) {
		command.Run = bar.run
	}
	return nil
}

// interactiveArgs reports whether a launch opens Muse Code's TUI, the only
// place a status bar belongs. `muse resume` reopens it too.
func interactiveArgs(args []string) bool {
	valueFlags := map[string]bool{
		"--agents": true, "--provider": true, "--preset": true, "--model": true, "--contributor-mode": true,
		"-c": true, "--config": true, "--reasoning-effort": true, "--effort": true, "--base-url": true,
		"--image": true, "--workspace": true, "--worktree-base": true, "--worktree-existing": true,
		"--approval-mode": true, "--permission-profile": true, "--approval-judge": true,
		"--sandbox-network": true, "--echo-delay-ms": true,
	}
	headless := map[string]bool{
		"exec": true, "config": true, "export": true, "trace": true, "model-profile": true, "skills": true,
		"voice": true, "plugins": true, "sandbox": true, "schema": true, "serve": true,
		"session-message": true, "mcp": true, "auth": true, "login": true, "logout": true, "usage": true,
		"init": true, "help": true,
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return true
		}
		if valueFlags[arg] {
			i++
			continue
		}
		if len(arg) > 0 && arg[0] == '-' {
			continue
		}
		return !headless[arg]
	}
	return true
}
