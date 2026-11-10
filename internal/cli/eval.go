package cli

import (
	"net/http"
	"net/url"

	"github.com/spf13/cobra"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		cmd := &cobra.Command{
			Use:     "eval",
			Aliases: []string{"evals"},
			Short:   "Inspect eval scorecards for the current org",
		}
		cmd.AddCommand(
			newEvalCreateCmd(gf),
			newEvalListCmd(gf),
			newEvalGetCmd(gf),
		)
		root.AddCommand(cmd)
	})
}

func newEvalListCmd(gf *globalFlags) *cobra.Command {
	var models []string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List eval scorecards visible to the current org",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			query := url.Values{}
			setRepeatedQuery(query, "model", models)
			path := "/v1/organizations/current/evals"
			if len(query) > 0 {
				path += "?" + query.Encode()
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodGet, path, nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	cmd.Flags().StringArrayVar(&models, "model", nil, "Keep evals that score this model ID; append :<level>,<level> to require any of those thinking levels (repeatable, every model must match)")
	return cmd
}

func newEvalGetCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "get <eval_id>",
		Short: "Show one eval scorecard for the current org",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/evals/"+url.PathEscape(args[0]), nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}
