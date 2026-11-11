package cli

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
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
			Short: "Choose where coding agents route, and run the local Dari Gateway",
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
				fmt.Fprintln(out, "Mode:     Hosted")
				fmt.Fprintln(out, "Switch:   dari gateway setup --mode local  (or self-hosted)")
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
				fmt.Fprintln(out, "Mode:          Fully local")
				fmt.Fprintf(out, "Gateway:       %s (%s)\n", gw.url, running)
				if version := gateway.InstalledVersion(); version != "" {
					fmt.Fprintf(out, "Version:       v%s\n", version)
				}
				fmt.Fprintf(out, "Auto-routing:  %s\n", autorouting)
				fmt.Fprintf(out, "Data:          %s\n", dir)
				fmt.Fprintln(out, "Activity:      unavailable; observability needs hosted mode")
			default:
				source := "dari gateway setup"
				if os.Getenv(gatewayURLEnv) != "" {
					source = gatewayURLEnv
				}
				fmt.Fprintln(out, "Mode:     Self-hosted")
				fmt.Fprintf(out, "Gateway:  %s (from %s)\n", gw.url, source)
				fmt.Fprintln(out, "Activity: unavailable; observability needs hosted mode")
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
	return &cobra.Command{
		Use:   "models",
		Short: "Choose the local gateway's models with the same picker as a hosted router",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			gw, err := localGateway()
			if err != nil {
				return err
			}
			if agentInputIsTerminal(cmd.InOrStdin()) {
				return chooseLocalGatewayModels(cmd.Context(), gw, cmd.InOrStdin(), cmd.ErrOrStderr())
			}
			current, err := localGatewayModels(cmd.Context())
			if err != nil {
				return err
			}
			for _, model := range current {
				fmt.Fprintln(cmd.OutOrStdout(), model.ID)
			}
			return nil
		},
	}
}
