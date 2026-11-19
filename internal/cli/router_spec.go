package cli

import (
	"fmt"
	"net/http"
	"net/url"
	"os"

	"github.com/spf13/cobra"
)

// A router spec is everything a router is, in one YAML file, with no
// credentials: `dari router get <id> --yaml` prints one, and `dari router
// apply <file>` creates or updates a router from one. The API parses and
// validates it, so every client reads specs the same way.

func newRouterApplyCmd(gf *globalFlags) *cobra.Command {
	var routerID string
	cmd := &cobra.Command{
		Use:   "apply <router.yaml>",
		Short: "Create or update a router from a router spec file",
		Long: "Create or update a router from a router spec file. It updates the router named by --router, " +
			"else your org's router with the spec's name, else creates one. Each model is paid for with your " +
			"subscription, then your org's key, then Dari credits, as the spec's payment.allow permits; " +
			"an existing router keeps the choices it already made. `dari router get <id> --yaml` prints a " +
			"router as a spec.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			spec, err := loadRouterSpec(args[0])
			if err != nil {
				return err
			}
			body := map[string]any{"spec_yaml": spec}
			if routerID != "" {
				id, err := normalizeRouterID(routerID)
				if err != nil {
					return err
				}
				body["router_id"] = id
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodPost, "/v1/organizations/current/routers/apply", body, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	cmd.Flags().StringVar(&routerID, "router", "", "Router to update (default: your router with the spec's name)")
	return cmd
}

// loadRouterSpec reads a spec file, or a directory holding router.yaml, as
// the text the API parses.
func loadRouterSpec(rawPath string) (string, error) {
	path, err := resolveRouterManifestPath(rawPath)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read router spec %s: %w", path, err)
	}
	return string(data), nil
}

func getRouterSpec(cmd *cobra.Command, gf *globalFlags, routerID string) error {
	var document []byte
	path := "/v1/organizations/current/routers/" + url.PathEscape(routerID) + "/spec?format=yaml"
	if err := orgKeyRequest(cmd, gf, http.MethodGet, path, nil, &document); err != nil {
		return err
	}
	_, err := cmd.OutOrStdout().Write(document)
	return err
}
