package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/codex"
)

// agentSetupTarget names what a setup of the agent run directly (cli) and of
// its desktop app (desktop) covers, and how it takes effect.
func agentSetupTarget(agent agents.Agent, cli, desktop bool) (string, string) {
	setup := agent.Setup
	if setup.SharedConfig {
		cli, desktop = true, true
	}
	names, applies := []string{}, []string{}
	if cli {
		names, applies = append(names, agent.Label), append(applies, setup.Applies)
	}
	if desktop && setup.Desktop != "" {
		names, applies = append(names, setup.Desktop), append(applies, setup.DesktopApplies)
	}
	return strings.Join(names, " and "), strings.Join(applies, "; ")
}

// runAgentSetup writes, or with --remove removes, the config the agent
// reads when run directly (--cli) or its desktop app reads (--desktop). Setup runs the launcher's onboarding first, so it uses
// the same router, key, and model menu as `dari <agent>`.
func runAgentSetup(ctx context.Context, launch agentLaunch, stdin io.Reader, stderr io.Writer) error {
	agent, ok := agentNamed(launch.name)
	if !ok || agent.Setup == nil {
		names := []string{}
		for _, agent := range agentList {
			if agent.Setup != nil {
				names = append(names, agent.Name)
			}
		}
		slices.Sort(names)
		return fmt.Errorf("--cli, --desktop, and --remove are only available for %s", strings.Join(names, ", "))
	}
	if launch.setup() && launch.removeSetup {
		return errors.New("use either --remove or --cli/--desktop, not both")
	}
	if launch.setupDesktop && agent.Setup.Desktop == "" {
		return fmt.Errorf("%s has no desktop app; use `dari setup %s --cli`", agent.Label, launch.name)
	}
	// Setup takes the launch's router choice (--router, --pay, --default),
	// which the routing step below reads, and no agent arguments.
	if probe := launch; true {
		if _, err := takeAgentRouterChoice(&probe); err != nil {
			return err
		}
		if len(probe.args) > 0 {
			return errors.New("setup does not take agent arguments")
		}
	}
	if launch.removeSetup {
		// Removal undoes both, whichever was set up.
		target, applies := agentSetupTarget(agent, true, true)
		removed, err := agent.Setup.Remove(ctx)
		if err != nil {
			return err
		}
		if !removed {
			agentStep(stderr, "Dari is not set up in "+target)
			return nil
		}
		agentStep(stderr, "Removed Dari from "+target+"; "+applies)
		return nil
	}
	key, baseURL, models, err := resolveAgentRouting(ctx, &launch, stdin, stderr)
	if err != nil {
		return err
	}
	// Only a setup that wrote a copy before leaves a background server on it.
	hadCopy := codexReadsCopiedCatalog(launch.name)
	if err := writeAgentSetup(ctx, launch.name, launch.setupCLI, launch.setupDesktop, key, baseURL, models); err != nil {
		return err
	}
	target, applies := agentSetupTarget(agent, launch.setupCLI, launch.setupDesktop)
	agentStep(stderr, fmt.Sprintf("Dari is set up in %s, starting on %s; %s", target, startModel(launch.name, models), applies))
	if hadCopy && codexReadsLiveCatalog(launch.name) {
		agentStep(stderr, codexBackgroundRestartNote)
	}
	agentStep(stderr, fmt.Sprintf("Run `dari setup %s` to change models, then `%s` again; `dari setup %s --remove` undoes it", launch.name, launch.setupCommand(), launch.name))
	return nil
}

// writeAgentSetup writes Dari into the agent's own config (cli) and its
// desktop app's (desktop). Only the Claude app has a config of its own; the
// Codex app reads the CLI's.
func writeAgentSetup(ctx context.Context, name string, cli, desktop bool, key, baseURL string, models agents.Models) error {
	agent, _ := agentNamed(name)
	setup := agent.Setup
	// The app first: it is the step that can refuse (the Claude app lists
	// only Claude models), and nothing is written when it does.
	if desktop && setup.SaveDesktop != nil {
		if err := setup.SaveDesktop(key, baseURL, models); err != nil {
			return err
		}
	}
	if cli || (desktop && setup.SaveDesktop == nil) {
		return setup.Save(ctx, key, baseURL, models)
	}
	return nil
}

// savedAgentModel is the model the agent saved as the user's last pick, or ""
// for agents that save none.
func savedAgentModel(name string) string {
	if agent, _ := agentNamed(name); agent.SavedModel != nil {
		return agent.SavedModel()
	}
	return ""
}

func capitalized(value string) string {
	if value == "" {
		return value
	}
	return strings.ToUpper(value[:1]) + value[1:]
}

// setUpAgents are the agents whose own config Dari is set up in, in the
// order Dari lists them.
func setUpAgents(ctx context.Context) []string {
	set := []string{}
	for _, agent := range agentList {
		if cli, desktop := agentSetUp(ctx, agent.Name); cli || desktop {
			set = append(set, agent.Name)
		}
	}
	return set
}

// agentSetUp reports whether the agent run directly, and its desktop app,
// have Dari set up. Only the Claude app is set up apart from its CLI.
func agentSetUp(ctx context.Context, name string) (cli, desktop bool) {
	if agent, _ := agentNamed(name); agent.Setup != nil {
		return agent.Setup.IsSetUp(ctx)
	}
	return false, false
}

// syncAgentSetup moves the agent run directly, and its desktop app, onto the
// router the agent now uses, wherever Dari is already set up there. Without
// it plain `claude` would keep the router it was set up with.
func syncAgentSetup(ctx context.Context, name, key, baseURL string, models agents.Models, stderr io.Writer) {
	cli, desktop := agentSetUp(ctx, name)
	if !cli && !desktop {
		return
	}
	agent, _ := agentNamed(name)
	target, _ := agentSetupTarget(agent, cli, desktop)
	if err := writeAgentSetup(ctx, name, cli, desktop, key, baseURL, models); err != nil {
		command := agentLaunch{name: name, setupCLI: cli, setupDesktop: desktop}.setupCommand()
		agentPrintln(stderr, fmt.Sprintf("%s still uses its earlier router (%v); run `%s`", capitalized(target), err, command))
		return
	}
	agentStep(stderr, capitalized(target)+" now uses it too")
}

// moveAgentSetups rewrites every set-up agent's own config for the current
// routing, so `claude`, `codex`, the desktop apps, OpenClaw, and Hermes follow
// a mode switch at once instead of on their next `dari <agent>` launch. An
// agent that cannot move is named with how to finish it; the others still move.
func moveAgentSetups(ctx context.Context, stdin io.Reader, stderr io.Writer) {
	agentNames := setUpAgents(ctx)
	if len(agentNames) == 0 {
		return
	}
	// Hosted routing needs a sign-in, which a switch must not start on its own.
	if gw, err := currentGateway(); err != nil || (gw == nil && !signedIn()) {
		agentStep(stderr, fmt.Sprintf("Set up agents (%s) still route the old way; sign in with `dari auth login`, then run `dari gateway setup --mode hosted` again to move them", strings.Join(agentNames, ", ")))
		return
	}
	for _, name := range agentNames {
		// Claude Code and the Claude app are set up apart; each moves only if set up.
		cli, desktop := agentSetUp(ctx, name)
		agent, _ := agentNamed(name)
		target, applies := agentSetupTarget(agent, cli, desktop)
		if err := moveAgentSetup(ctx, name, cli, desktop, stdin, stderr); err != nil {
			command := agentLaunch{name: name, setupCLI: cli, setupDesktop: desktop}.setupCommand()
			agentPrintln(stderr, fmt.Sprintf("%s still routes the old way (%v); run `%s`", capitalized(target), err, command))
			continue
		}
		agentStep(stderr, capitalized(target)+" moved; "+applies)
	}
}

func moveAgentSetup(ctx context.Context, name string, cli, desktop bool, stdin io.Reader, stderr io.Writer) error {
	key, baseURL, models, err := existingAgentRouting(ctx, name, stdin, stderr)
	if err != nil {
		return err
	}
	// Keep the user's last model pick, as a launch does.
	models.Saved = savedAgentModel(name)
	return writeAgentSetup(ctx, name, cli, desktop, key, baseURL, models)
}

// existingAgentRouting is where an agent routes in the current mode, found
// without onboarding: a switch rewrites configs and never opens a model
// picker or creates a router. An agent with no hosted router yet is named
// with how to set it up.
func existingAgentRouting(ctx context.Context, name string, stdin io.Reader, stderr io.Writer) (string, string, agents.Models, error) {
	gw, err := currentGateway()
	if err != nil {
		return "", "", agents.Models{}, err
	}
	if gw != nil {
		if err := gw.ensure(ctx, stderr); err != nil {
			return "", "", agents.Models{}, err
		}
		models, err := routerModels(ctx, gw.url, gw.key, name)
		return gw.key, gw.url, models, err
	}
	access, err := resolveAgentRoutingAccess(ctx, stdin, stderr)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	client, err := auth.OrgKeyClient(access.apiURL)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	routers, err := listAgentRouters(ctx, client)
	if err != nil {
		return "", "", agents.Models{}, err
	}
	setup := agentSetups[name]
	router, ok := setup.assignedAgentRouter(routers)
	if !ok && setup.ownsRouter() {
		// Launch decides between the agent's own routers the same way: its own
		// provider's subscription connected uses the subscription router even
		// over an earlier opt-out; otherwise an opt-out keeps the managed one.
		optedOut, err := agentSubscriptionOptedOut(ctx, client, name)
		if err != nil {
			return "", "", agents.Models{}, err
		}
		subscribed, err := connectedAgentSubscriptions(ctx, client, setup.subscriptions)
		if err != nil {
			return "", "", agents.Models{}, err
		}
		ownConnected := slices.Contains(subscribed, setup.subscriptions[0])
		clientKey, _ := setup.ownRouter(ownConnected || (!optedOut && len(subscribed) > 0))
		router, ok = findAgentRouter(routers, func(router agentRouter) bool { return router.ClientKey == clientKey })
	}
	if !ok && !setup.ownsRouter() {
		router, ok = findAgentRouter(routers, func(router agentRouter) bool { return router.IsDefault })
	}
	if !ok || len(router.EnabledModels) == 0 {
		return "", "", agents.Models{}, errors.New("it has no hosted router yet")
	}
	baseURL := agentRoutingBaseURL(router.ID)
	models, err := routerModels(ctx, baseURL, access.key, name)
	return access.key, baseURL, models, err
}

// codexBackgroundRestartNote is for a Codex whose setup moved from a copy of
// the model list to the router's own: a background server started before
// keeps the copy until it restarts, and follows the router from then on.
const codexBackgroundRestartNote = "Codex now reads its /model list from the router and keeps it current; " +
	"restart its background server once so open windows switch too: `codex app-server daemon restart` " +
	"(this interrupts running Codex turns)"

// codexReadsLiveCatalog reports whether agent is Codex set up to read its
// model list from the router.
func codexReadsLiveCatalog(agent string) bool {
	if agent != "codex" {
		return false
	}
	home, err := codex.Home()
	return err == nil && codex.ReadsLiveCatalog(home)
}

// codexReadsCopiedCatalog reports whether agent is Codex set up with a copy
// of the router's model list.
func codexReadsCopiedCatalog(agent string) bool {
	if agent != "codex" {
		return false
	}
	home, err := codex.Home()
	return err == nil && codex.IsSetUp(home) && !codex.ReadsLiveCatalog(home)
}

// runCodexRefresh brings Codex's /model list up to the models its router
// serves now, on the router Codex is set up with: no picker, no other
// router, and the user's model pick is kept while the router still has it.
func runCodexRefresh(ctx context.Context, stderr io.Writer) error {
	home, err := codex.Home()
	if err != nil {
		return err
	}
	baseURL, key, ok := codex.SetupRouting(home)
	if !ok {
		agentStep(stderr, "Dari is not set up in Codex: `dari codex` reads the router's models each time it starts; `dari setup codex --cli` sets up plain `codex`")
		return nil
	}
	models, err := routerModels(ctx, baseURL, key, "codex")
	if errors.Is(err, errRouterKeyRefused) {
		return errors.New("the router did not accept the key Codex is set up with; run `dari setup codex --cli` to set it up again")
	}
	if err != nil {
		return fmt.Errorf("could not read the models of the router Codex is set up with (%s): %w", baseURL, err)
	}
	models.Saved = codex.SavedModel(home)
	wasLive := codex.ReadsLiveCatalog(home)
	if err := codex.Agent.Setup.Save(ctx, key, baseURL, models); err != nil {
		return err
	}
	if err := codex.ForgetModelList(home); err != nil {
		return err
	}
	switch live := codex.ReadsLiveCatalog(home); {
	case live && wasLive:
		agentStep(stderr, fmt.Sprintf("Codex's /model list is up to date (%s); open /model again to see it", strings.Join(models.Menu(), ", ")))
	case live:
		agentStep(stderr, fmt.Sprintf("Codex's /model list is up to date (%s)", strings.Join(models.Menu(), ", ")))
		agentStep(stderr, codexBackgroundRestartNote)
	default:
		agentStep(stderr, fmt.Sprintf("Codex's /model list is up to date (%s); new Codex windows show it, "+
			"and windows already open show it after `codex app-server daemon restart` (this interrupts running Codex turns)",
			strings.Join(models.Menu(), ", ")))
		if version, err := codex.Version(ctx); err == nil && version != "" && !codex.ReadsLiveCatalogVersion(version) {
			agentStep(stderr, "Update Codex to 0.156 or newer, then run `dari setup codex --refresh` again: "+
				"Codex then reads its /model list from the router and keeps it current")
		}
	}
	if saved := models.Saved; saved != "" && !slices.Contains(models.Menu(), saved) {
		agentStep(stderr, fmt.Sprintf("The router no longer serves %s, your last /model pick; Codex starts on %s instead", saved, models.Default()))
	}
	return nil
}
