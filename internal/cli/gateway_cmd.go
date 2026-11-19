package cli

import (
	"errors"
	"fmt"
	"os"

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
				"gateway. `start` and `stop` manage only the Fully local gateway. Launches start it on\n" +
				"their own; start it yourself for agents run directly after `dari setup <agent> --cli`.\n" +
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
				autorouting := "off (add a Dari API key with `dari accounts auto-routing`)"
				if gw.settings.AutoRoutingKey != "" {
					autorouting = "on"
				}
				dir, _ := gateway.Dir()
				fmt.Fprintln(out, "Mode:      Fully local")
				fmt.Fprintf(out, "Endpoint:  %s\n", gw.url)
				fmt.Fprintf(out, "Runtime:   local gateway %s\n", running)
				fmt.Fprintln(out, "Activity:  served by the gateway")
				fmt.Fprintf(out, "Hosted:    %s (`dari router`, `api-keys`, `org` act on it)\n", hostedAccount())
				if version := gateway.InstalledVersion(); version != "" {
					fmt.Fprintf(out, "Version:   v%s\n", version)
				}
				fmt.Fprintf(out, "Auto-routing: %s\n", autorouting)
				fmt.Fprintf(out, "Data:         %s\n", dir)
				if log, err := gateway.LogPath(); err == nil {
					fmt.Fprintf(out, "Log:          %s\n", log)
				}
			default:
				source := "saved settings"
				if os.Getenv(gatewayURLEnv) != "" {
					source = gatewayURLEnv
				}
				fmt.Fprintln(out, "Mode:      Self-hosted")
				fmt.Fprintf(out, "Endpoint:  %s\n", gw.url)
				fmt.Fprintln(out, "Runtime:   external gateway")
				fmt.Fprintln(out, "Activity:  served by the gateway")
				fmt.Fprintf(out, "Hosted:    %s (`dari router`, `api-keys`, `org` act on it)\n", hostedAccount())
				fmt.Fprintf(out, "Configured via: %s\n", source)
			}
			return nil
		},
	}
}
