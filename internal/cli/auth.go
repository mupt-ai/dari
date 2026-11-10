package cli

import (
	"os"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/state"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		auth := &cobra.Command{
			Use:   "auth",
			Short: "Manage browser login state",
		}
		auth.AddCommand(
			newAuthLoginCmd(gf),
			newAuthLogoutCmd(gf),
			newAuthStatusCmd(gf),
		)
		root.AddCommand(auth)
	})
}

func newAuthLoginCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Open the browser and log in with Supabase auth.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			apiURL, err := gf.resolveAPIURL()
			if err != nil {
				return err
			}
			s, err := loginWithBrowser(cmd.Context(), apiURL, cmd.InOrStdin(), cmd.ErrOrStderr(), "Sign in to the Dari CLI")
			if err != nil {
				return err
			}
			// The login page already reported the account on a terminal; a
			// piped stdout still gets the machine-readable summary.
			if agentInputIsTerminal(os.Stdout) {
				return nil
			}
			return printJSON(authLoginOutput(s))
		},
	}
}

func newAuthLogoutCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Clear local browser login state.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			apiURL, err := gf.resolveAPIURL()
			if err != nil {
				return err
			}
			if err := auth.Logout(cmd.Context(), apiURL); err != nil {
				return err
			}
			return printJSON(map[string]any{"logged_out": true})
		},
	}
}

func newAuthStatusCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the current browser login and org selection.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			apiURL, err := gf.resolveAPIURL()
			if err != nil {
				return err
			}
			status, err := auth.CurrentStatus(apiURL)
			if err != nil {
				return err
			}
			return printJSON(authStatusOutput(status))
		},
	}
}

// authLoginOutput shapes the JSON response for `dari auth login` to match the
// Python CLI: {api_url, email, current_org}.
func authLoginOutput(s *state.CliState) map[string]any {
	out := map[string]any{
		"api_url":     nilIfEmpty(s.APIURL),
		"email":       nil,
		"current_org": nil,
	}
	if s.SupabaseSession != nil {
		out["email"] = s.SupabaseSession.Email
	}
	if org := s.CurrentOrg(); org != nil {
		out["current_org"] = orgToMap(*org)
	}
	return out
}

// authStatusOutput shapes the JSON response for `dari auth status`:
// {api_url, email, current_org, logged_in, session_mode}.
func authStatusOutput(s auth.Status) map[string]any {
	out := map[string]any{
		"api_url":      nilIfEmpty(s.APIURL),
		"email":        nilIfEmpty(s.Email),
		"current_org":  nil,
		"logged_in":    s.LoggedIn,
		"session_mode": nilIfEmpty(s.SessionMode),
	}
	if s.CurrentOrg != nil {
		out["current_org"] = orgToMap(*s.CurrentOrg)
	}
	return out
}

func orgToMap(o state.Organization) map[string]any {
	return map[string]any{
		"id":      o.ID,
		"name":    o.Name,
		"slug":    o.Slug,
		"role":    o.Role,
		"api_key": nilIfEmpty(o.APIKey),
	}
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
