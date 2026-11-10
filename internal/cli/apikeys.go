package cli

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/spf13/cobra"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		cmd := &cobra.Command{Use: "api-keys", Short: "Manage API keys for the current org"}
		cmd.AddCommand(
			newAPIKeysListCmd(gf),
			newAPIKeysCreateCmd(gf),
			newAPIKeysRevokeCmd(gf),
		)
		root.AddCommand(cmd)
	})
}

func newAPIKeysListCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List API keys for the current org",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var resp struct {
				APIKeys []any `json:"api_keys"`
			}
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/api-keys", nil, &resp); err != nil {
				return err
			}
			return printJSON(map[string]any{"api_keys": resp.APIKeys})
		},
	}
}

func newAPIKeysCreateCmd(gf *globalFlags) *cobra.Command {
	var (
		name    string
		keyType string
	)
	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new manual API key for the current org",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			normalizedType, err := normalizeAPIKeyType(keyType)
			if err != nil {
				return err
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodPost, "/v1/organizations/current/api-keys",
				map[string]any{"label": name, "key_type": normalizedType}, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "Key label")
	cmd.Flags().StringVar(&keyType, "type", "management", "Key type: management for API/CLI, routing for router traffic")
	_ = cmd.MarkFlagRequired("name")
	return cmd
}

func normalizeAPIKeyType(keyType string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(keyType))
	switch normalized {
	case "", "management":
		return "management", nil
	case "routing":
		return "routing", nil
	default:
		return "", fmt.Errorf("unsupported API key type %q (supported: management, routing)", keyType)
	}
}

func newAPIKeysRevokeCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <key_id>",
		Short: "Revoke an API key for the current org",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodDelete, "/v1/organizations/current/api-keys/"+args[0], nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}
