package cli

import (
	"fmt"
	"net/http"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/state"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		org := &cobra.Command{Use: "org", Short: "Hosted only: manage organizations"}
		org.AddCommand(
			newOrgListCmd(gf),
			newOrgCreateCmd(gf),
			newOrgSwitchCmd(gf),
			newOrgDeleteCmd(gf),
			newOrgMembersCmd(gf),
			newOrgInviteCmd(gf),
		)
		root.AddCommand(org)
	})
}

func newOrgListCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List available orgs",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			apiURL, err := gf.resolveAPIURL()
			if err != nil {
				return err
			}
			s, orgs, err := auth.ListOrganizations(cmd.Context(), apiURL)
			if err != nil {
				return err
			}
			return printJSON(map[string]any{
				"current_org_id": nilIfEmpty(s.CurrentOrgID),
				"organizations":  orgs,
			})
		},
	}
}

func newOrgCreateCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "create <name>",
		Short: "Create a new org",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			apiURL, err := gf.resolveAPIURL()
			if err != nil {
				return err
			}
			s, err := auth.CreateOrganization(cmd.Context(), apiURL, args[0])
			if err != nil {
				return err
			}
			return printJSON(orgCreateOrSwitchOutput(s))
		},
	}
}

func newOrgDeleteCmd(gf *globalFlags) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:   "delete <organization>",
		Short: "Delete an organization by slug or ID. Owner only. Soft-delete.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			identifier := args[0]
			if !yes && !confirm(fmt.Sprintf("Delete organization %s? [y/N] ", identifier)) {
				return fmt.Errorf("aborted")
			}
			apiURL, err := gf.resolveAPIURL()
			if err != nil {
				return err
			}
			s, deleted, err := auth.DeleteOrganization(cmd.Context(), apiURL, identifier)
			if err != nil {
				return err
			}
			return printJSON(map[string]any{
				"current_org_id":       nilIfEmpty(s.CurrentOrgID),
				"deleted_organization": orgRecordToMap(deleted),
			})
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "Skip the interactive confirmation prompt")
	return cmd
}

func newOrgSwitchCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "switch <organization>",
		Short: "Switch the current org by slug or ID",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			apiURL, err := gf.resolveAPIURL()
			if err != nil {
				return err
			}
			s, err := auth.SwitchOrganization(cmd.Context(), apiURL, args[0])
			if err != nil {
				return err
			}
			return printJSON(orgCreateOrSwitchOutput(s))
		},
	}
}

func newOrgMembersCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "members",
		Short: "List members in the current org",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var resp struct {
				Members []any `json:"members"`
			}
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/members", nil, &resp); err != nil {
				return err
			}
			return printJSON(map[string]any{"members": resp.Members})
		},
	}
}

func newOrgInviteCmd(gf *globalFlags) *cobra.Command {
	var role string
	cmd := &cobra.Command{
		Use:   "invite <email>",
		Short: "Invite a user to the current org",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if role != "owner" && role != "admin" && role != "member" {
				return fmt.Errorf("invalid role %q: expected owner, admin, or member", role)
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodPost, "/v1/organizations/current/invitations",
				map[string]string{"email": args[0], "role": role}, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	cmd.Flags().StringVar(&role, "role", "member", "Membership role for the invite (owner|admin|member)")
	return cmd
}

func orgRecordToMap(r auth.OrgRecord) map[string]any {
	return map[string]any{
		"id":   r.ID,
		"name": r.Name,
		"slug": r.Slug,
		"role": r.Role,
	}
}

func orgCreateOrSwitchOutput(s *state.CliState) map[string]any {
	out := map[string]any{
		"current_org_id": nilIfEmpty(s.CurrentOrgID),
		"organization":   nil,
	}
	if org := s.CurrentOrg(); org != nil {
		out["organization"] = orgToMap(*org)
	}
	return out
}
