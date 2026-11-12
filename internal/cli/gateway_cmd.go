package cli

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/gateway"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		var mode, url, key, autoRoutingKey string
		cmd := &cobra.Command{
			Use:   "gateway",
			Short: "Choose a routing mode and manage the local gateway",
			Long: "Choose Hosted, Fully local, or Self-hosted routing with `dari gateway setup`.\n\n" +
				"`status` and `setup` work in every mode, and `models` with a local or self-hosted\n" +
				"gateway. The other commands manage only the Fully local gateway; they do not install,\n" +
				"start, or inspect a self-hosted gateway.\n" +
				"Hosted routing is managed by Dari. Use `dari accounts` for accounts and keys\n" +
				"supported by the selected mode. Activity and team analytics require Hosted mode.",
		}
		cmd.AddCommand(
			&cobra.Command{
				Use:   "setup",
				Short: "Choose hosted, fully local, or self-hosted routing",
				Long: "Choose where coding agents route. Without --mode this opens the menu, which needs a terminal.\n" +
					"With --mode it saves the choice without a terminal, for scripts and agents:\n" +
					"  dari gateway setup --mode hosted\n" +
					"  dari gateway setup --mode local [--auto-routing-key KEY]\n" +
					"  dari gateway setup --mode self-hosted --url URL --key KEY",
				Args: cobra.NoArgs,
				RunE: func(cmd *cobra.Command, _ []string) error {
					if mode == "" {
						return runGatewaySetup(cmd.Context(), cmd.InOrStdin(), cmd.ErrOrStderr())
					}
					return setGatewayModeFromFlags(cmd.Context(), mode, url, key, autoRoutingKey, cmd.InOrStdin(), cmd.ErrOrStderr())
				},
			},
			newGatewayStatusCmd(),
			&cobra.Command{
				Use:   "start",
				Short: "Start the local gateway in the background",
				Args:  cobra.NoArgs,
				RunE: func(cmd *cobra.Command, _ []string) error {
					gw, err := localGateway()
					if err != nil {
						return err
					}
					return gw.ensure(cmd.Context(), cmd.ErrOrStderr())
				},
			},
			&cobra.Command{
				Use:   "stop",
				Short: "Stop the local gateway",
				Args:  cobra.NoArgs,
				RunE: func(cmd *cobra.Command, _ []string) error {
					stopped, err := gateway.Stop(cmd.Context())
					if err == nil && !stopped {
						fmt.Fprintln(cmd.ErrOrStderr(), "The local gateway is not running")
					}
					return err
				},
			},
			&cobra.Command{
				Use:   "restart",
				Short: "Restart the local gateway, picking up provider keys from this shell",
				Args:  cobra.NoArgs,
				RunE: func(cmd *cobra.Command, _ []string) error {
					gw, err := localGateway()
					if err != nil {
						return err
					}
					if err := gateway.Restart(cmd.Context(), gw.settings, cliVersion); err != nil {
						return err
					}
					return gw.ensure(cmd.Context(), cmd.ErrOrStderr())
				},
			},
			&cobra.Command{
				Use:   "serve",
				Short: "Run the local gateway in the foreground",
				Args:  cobra.NoArgs,
				RunE: func(cmd *cobra.Command, _ []string) error {
					gw, err := localGateway()
					if err != nil {
						return err
					}
					if gateway.Healthy(cmd.Context()) {
						return errors.New("the local gateway is already running; stop it with `dari gateway stop`")
					}
					if err := gateway.EnsureInstalled(cmd.Context(), cliVersion, func(line string) { agentStep(cmd.ErrOrStderr(), line) }); err != nil {
						return err
					}
					process, err := gateway.Command(gw.settings, cmd.OutOrStdout())
					if err != nil {
						return err
					}
					signal.Ignore(os.Interrupt, syscall.SIGTERM)
					defer signal.Reset(os.Interrupt, syscall.SIGTERM)
					if err := gateway.MarkRunning(); err != nil {
						return err
					}
					defer gateway.ClearRunning()
					return process.Run()
				},
			},
			&cobra.Command{
				Use:   "install",
				Short: "Install or update the local gateway",
				Args:  cobra.NoArgs,
				RunE: func(cmd *cobra.Command, _ []string) error {
					version, err := gateway.Install(cmd.Context(), cliVersion)
					if err != nil {
						return err
					}
					fmt.Fprintf(cmd.ErrOrStderr(), "Dari Gateway %s installed\n", version)
					if gw, err := currentGateway(); err == nil && gw != nil && gw.local {
						return gateway.Restart(cmd.Context(), gw.settings, cliVersion)
					}
					return nil
				},
			},
			&cobra.Command{
				Use:   "logs",
				Short: "Print the local gateway's log",
				Args:  cobra.NoArgs,
				RunE: func(cmd *cobra.Command, _ []string) error {
					path, err := gateway.LogPath()
					if err != nil {
						return err
					}
					raw, err := os.ReadFile(path)
					if errors.Is(err, os.ErrNotExist) {
						return errors.New("the local gateway has not logged anything yet")
					}
					if err != nil {
						return err
					}
					_, err = cmd.OutOrStdout().Write(raw)
					return err
				},
			},
			newGatewayAutoRoutingCmd(),
			newGatewayModelsCmd(),
		)
		for _, sub := range cmd.Commands() {
			if sub.Name() != "setup" {
				continue
			}
			sub.Flags().StringVar(&mode, "mode", "", "hosted, local, or self-hosted; omit for the menu")
			sub.Flags().StringVar(&url, "url", "", "self-hosted: the gateway's URL")
			sub.Flags().StringVar(&key, "key", "", "self-hosted: one of the gateway's DARI_GATEWAY_KEYS")
			sub.Flags().StringVar(&autoRoutingKey, "auto-routing-key", "", "local: Dari API key for auto-routing")
		}
		root.AddCommand(cmd)
	})
}

// localGateway is the saved local gateway, or an error naming how to choose
// one.
func localGateway() (*gatewayConfig, error) {
	settings, ok, err := gateway.Load()
	if err != nil {
		return nil, err
	}
	if !ok || settings.Mode != gateway.ModeLocal {
		return nil, errors.New("routing is not set to a local gateway; choose Fully local with `dari gateway setup`")
	}
	return &gatewayConfig{url: gateway.LocalURL(), key: settings.LocalKey, local: true, settings: settings}, nil
}

func newGatewayStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show where coding agents route",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			out := cmd.OutOrStdout()
			gw, err := currentGateway()
			if err != nil {
				return err
			}
			switch {
			case gw == nil:
				fmt.Fprintln(out, "Mode:      Hosted")
				fmt.Fprintf(out, "Endpoint:  %s\n", routingBaseURL)
				fmt.Fprintln(out, "Runtime:   managed by Dari")
				fmt.Fprintln(out, "Activity:  available")
			case gw.local:
				running := "stopped"
				if gateway.Healthy(cmd.Context()) {
					running = "running"
				}
				autorouting := "off (add a Dari API key with `dari gateway auto-routing`)"
				if gw.settings.AutoRoutingKey != "" {
					autorouting = "on"
				}
				dir, _ := gateway.Dir()
				fmt.Fprintln(out, "Mode:      Fully local")
				fmt.Fprintf(out, "Endpoint:  %s\n", gw.url)
				fmt.Fprintf(out, "Runtime:   local gateway %s\n", running)
				fmt.Fprintln(out, "Activity:  unavailable (hosted mode only)")
				if version := gateway.InstalledVersion(); version != "" {
					fmt.Fprintf(out, "Version:   v%s\n", version)
				}
				fmt.Fprintf(out, "Auto-routing: %s\n", autorouting)
				fmt.Fprintf(out, "Data:         %s\n", dir)
			default:
				source := "saved settings"
				if os.Getenv(gatewayURLEnv) != "" {
					source = gatewayURLEnv
				}
				fmt.Fprintln(out, "Mode:      Self-hosted")
				fmt.Fprintf(out, "Endpoint:  %s\n", gw.url)
				fmt.Fprintln(out, "Runtime:   external gateway")
				fmt.Fprintln(out, "Activity:  unavailable (hosted mode only)")
				fmt.Fprintf(out, "Configured via: %s\n", source)
			}
			return nil
		},
	}
}

func newGatewayAutoRoutingCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "auto-routing <dari-api-key|off>",
		Short: "Route the local gateway with Dari's routing policy, using your Dari API key",
		Long: "Auto-routing picks the model for each request with Dari's routing policy. The local gateway calls it with a Dari API key.\n" +
			"A self-hosted gateway's operator sets DARI_AUTO_ROUTING_API_KEY on the server instead; hosted Dari includes it with the Autorouting plan.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			gw, err := localGateway()
			if err != nil {
				return err
			}
			gw.settings.AutoRoutingKey = strings.TrimSpace(args[0])
			if strings.EqualFold(gw.settings.AutoRoutingKey, "off") {
				gw.settings.AutoRoutingKey = ""
			}
			if err := gateway.Save(gw.settings); err != nil {
				return err
			}
			return gateway.Restart(cmd.Context(), gw.settings, cliVersion)
		},
	}
}

func newGatewayModelsCmd() *cobra.Command {
	var agent string
	var reset bool
	cmd := &cobra.Command{
		Use:   "models [model[=thinking,...]]...",
		Short: "Choose the models a local or self-hosted gateway serves",
		Long: "Choose the models the gateway serves, with the same picker as a hosted router. Every coding\n" +
			"agent is offered them, less the ones no connected account or API key can serve it.\n\n" +
			"With --agent, choose a list for one coding agent, which it is offered in place of the\n" +
			"gateway's models. Agents are " + strings.Join(codingAgentNames(), ", ") + ".\n\n" +
			"Name the models to set them without the picker, for scripts and agents, in the order the\n" +
			"gateway tries them. A model takes every thinking level it supports unless some are named:\n" +
			"  dari gateway models anthropic/claude-sonnet-5-5 openai/gpt-6.1-sol=medium,high\n" +
			"  dari gateway models --agent codex openai/gpt-6.1-sol\n" +
			"With no models and no terminal this prints the current ones.\n\n" +
			"The gateway saves the choice and serves it at once, in place of the models in its config\n" +
			"file. --reset forgets the choice, so the config file's models are served again.",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, stderr := cmd.Context(), cmd.ErrOrStderr()
			saved := "Models"
			if agent != "" {
				setup, ok := agentSetups[agent]
				if !ok {
					return fmt.Errorf("unknown coding agent %q; use one of %s", agent, strings.Join(codingAgentNames(), ", "))
				}
				saved = setup.label + " models"
			}
			if reset && len(args) > 0 {
				return errors.New("--reset takes no models")
			}
			chosen, err := gatewayModelArgs(args)
			if err != nil {
				return err
			}
			gw, err := currentGateway()
			if err != nil {
				return err
			}
			if gw == nil {
				return errors.New("routing is hosted, where each router has its own models (see `dari router --help`); " +
					"`dari gateway models` is for a local or self-hosted gateway")
			}
			if err := gw.ensure(ctx, stderr); err != nil {
				return err
			}
			switch {
			case reset:
				if err := saveGatewayModels(ctx, gw, agent, nil); err != nil {
					return err
				}
				agentStep(stderr, saved+": back to the gateway's config")
			case len(chosen) > 0:
				if err := saveGatewayModels(ctx, gw, agent, chosen); err != nil {
					return err
				}
				agentStep(stderr, fmt.Sprintf("%s: %d selected", saved, len(chosen)))
			case agentInputIsTerminal(cmd.InOrStdin()):
				return chooseGatewayModels(ctx, gw, agent, cmd.InOrStdin(), stderr)
			default:
				lists, err := fetchGatewayModelLists(ctx, gw)
				if err != nil {
					return err
				}
				for _, model := range lists.offered(agent) {
					fmt.Fprintln(cmd.OutOrStdout(), model.ID)
				}
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&agent, "agent", "", "choose one coding agent's own models")
	cmd.Flags().BoolVar(&reset, "reset", false, "forget the choice and serve the gateway's config again")
	return cmd
}

var gatewayThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// gatewayModelArgs reads models named on the command line, each a
// provider/model id with optional thinking levels after "=".
func gatewayModelArgs(args []string) ([]gatewayModelConfig, error) {
	models := make([]gatewayModelConfig, 0, len(args))
	for _, arg := range args {
		id, levels, hasLevels := strings.Cut(arg, "=")
		if provider, name, ok := strings.Cut(id, "/"); !ok || provider == "" || name == "" || strings.ContainsAny(id, " \t") {
			return nil, fmt.Errorf("%q is not a provider/model id, such as openai/gpt-6.1-sol", id)
		}
		if slices.ContainsFunc(models, func(model gatewayModelConfig) bool { return model.ID == id }) {
			return nil, fmt.Errorf("%s is named twice", id)
		}
		model := gatewayModelConfig{ID: id}
		if hasLevels {
			model.Thinking = strings.Split(levels, ",")
			for _, level := range model.Thinking {
				if !slices.Contains(gatewayThinkingLevels, level) {
					return nil, fmt.Errorf("%s has unknown thinking level %q; use %s", id, level, strings.Join(gatewayThinkingLevels, ", "))
				}
			}
		}
		models = append(models, model)
	}
	return models, nil
}
