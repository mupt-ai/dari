package cli

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/mupt-ai/dari/internal/auth"
	"github.com/spf13/cobra"
)

// personalEndpointTerms is what the user agrees to before creating a personal
// endpoint, word for word as the app's Create Endpoint dialog shows it.
const personalEndpointTerms = "Only for me, in apps that take my key. Not for serving others."

// Personal endpoints are Dari Link grants the user makes for themselves; the
// routing service serves them, apart from any router.

type personalEndpointCredential struct {
	CredentialID    string   `json:"credential_id"`
	MonthlyLimitUSD *float64 `json:"monthly_usd,omitempty"`
}

type personalEndpoint struct {
	ID            string   `json:"id"`
	Name          string   `json:"app_name"`
	Endpoint      bool     `json:"endpoint"`
	CredentialIDs []string `json:"credential_ids"`
	Limits        []struct {
		CredentialID string  `json:"credential_id"`
		MonthlyUSD   float64 `json:"monthly_usd"`
	} `json:"limits"`
}

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		cmd := &cobra.Command{
			Use:     "endpoint",
			Short:   "Use your subscriptions and API keys in other apps",
			Long:    "Personal endpoints serve you alone, on the plans and API keys you choose, each up to an optional monthly spend.\n\n" + personalEndpointTerms,
			GroupID: hostedGroup,
		}
		cmd.AddCommand(
			newEndpointListCmd(gf),
			newEndpointPlansCmd(gf),
			newEndpointCreateCmd(gf),
			newEndpointUpdateCmd(gf),
			newEndpointKeyCmd(gf),
			newEndpointDeleteCmd(gf),
		)
		root.AddCommand(cmd)
	})
}

// linkRequest calls the routing service's Dari Link routes with your key.
func linkRequest(cmd *cobra.Command, gf *globalFlags, method, path string, body, out any) error {
	apiURL, err := gf.resolveAPIURL()
	if err != nil {
		return err
	}
	client, err := auth.OrgKeyClient(apiURL)
	if err != nil {
		return err
	}
	client.BaseURL = activityBaseURL(apiURL)
	return client.Do(cmd.Context(), method, path, body, out)
}

// parseEndpointCredentials reads `<credential_id>[=<monthly limit in USD>]`.
func parseEndpointCredentials(values []string) (ids []string, limits []personalEndpointCredential, err error) {
	for _, value := range values {
		id, limit, hasLimit := strings.Cut(strings.TrimSpace(value), "=")
		if id == "" {
			return nil, nil, fmt.Errorf("--credential takes <credential_id>[=<monthly limit in USD>], got %q", value)
		}
		ids = append(ids, id)
		if !hasLimit {
			continue
		}
		usd, err := strconv.ParseFloat(strings.TrimPrefix(limit, "$"), 64)
		if err != nil || usd < 0 {
			return nil, nil, fmt.Errorf("monthly limit for %s must be a dollar amount, got %q", id, limit)
		}
		limits = append(limits, personalEndpointCredential{CredentialID: id, MonthlyLimitUSD: &usd})
	}
	return ids, limits, nil
}

const credentialFlagUsage = "Plan or API key to use, as <credential_id>[=<monthly limit in USD>]; repeat for each (ids from `dari endpoint plans`)"

func newEndpointListCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List your endpoints with each plan and key's spend this month",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var resp struct {
				Grants []map[string]any `json:"grants"`
			}
			if err := linkRequest(cmd, gf, http.MethodGet, "/v1/link/grants", nil, &resp); err != nil {
				return err
			}
			endpoints := []map[string]any{}
			for _, grant := range resp.Grants {
				if grant["endpoint"] == true {
					endpoints = append(endpoints, grant)
				}
			}
			return printJSON(map[string]any{"endpoints": endpoints})
		},
	}
}

func newEndpointPlansCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "plans",
		Short: "List the plans and API keys an endpoint can use",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var resp map[string]any
			if err := linkRequest(cmd, gf, http.MethodGet, "/v1/link/plans", nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

func newEndpointCreateCmd(gf *globalFlags) *cobra.Command {
	var (
		credentialFlags []string
		agree           bool
	)
	cmd := &cobra.Command{
		Use:   "create <name>",
		Short: "Create an endpoint and issue it a key",
		Long:  "Create an endpoint other apps call with your own key. You agree first:\n\n  " + personalEndpointTerms,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ids, limits, err := parseEndpointCredentials(credentialFlags)
			if err != nil {
				return err
			}
			if !agree && !confirm(personalEndpointTerms+" Agree? [y/N] ") {
				return fmt.Errorf("agree to the terms to create an endpoint: %s (or pass --agree)", personalEndpointTerms)
			}
			var resp struct {
				Key string `json:"key"`
			}
			body := map[string]any{"name": args[0], "credential_ids": ids, "limits": nonNilLimits(limits)}
			if err := linkRequest(cmd, gf, http.MethodPost, "/v1/link/endpoints", body, &resp); err != nil {
				return err
			}
			apiURL, err := gf.resolveAPIURL()
			if err != nil {
				return err
			}
			printEndpointAccess(cmd.OutOrStdout(), activityBaseURL(apiURL), resp.Key)
			return nil
		},
	}
	cmd.Flags().StringArrayVar(&credentialFlags, "credential", nil, credentialFlagUsage)
	cmd.Flags().BoolVar(&agree, "agree", false, "Agree to the terms without the prompt: "+personalEndpointTerms)
	_ = cmd.MarkFlagRequired("credential")
	return cmd
}

func newEndpointUpdateCmd(gf *globalFlags) *cobra.Command {
	var (
		name            string
		credentialFlags []string
	)
	cmd := &cobra.Command{
		Use:   "update <endpoint_id_or_name>",
		Short: "Rename an endpoint or replace its plans, keys, and limits",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			current, err := findPersonalEndpoint(cmd, gf, args[0])
			if err != nil {
				return err
			}
			path := "/v1/link/grants/" + url.PathEscape(current.ID)
			change := map[string]any{}
			if cmd.Flags().Changed("name") {
				change["name"] = name
			}
			var limits []personalEndpointCredential
			if cmd.Flags().Changed("credential") {
				var ids []string
				if ids, limits, err = parseEndpointCredentials(credentialFlags); err != nil {
					return err
				}
				change["credential_ids"] = ids
			}
			if len(change) > 0 {
				if err := linkRequest(cmd, gf, http.MethodPut, path, change, nil); err != nil {
					return err
				}
			}
			if cmd.Flags().Changed("credential") {
				if err := linkRequest(cmd, gf, http.MethodPut, path+"/limits", map[string]any{"limits": nonNilLimits(limits)}, nil); err != nil {
					return err
				}
			}
			updated, err := findPersonalEndpoint(cmd, gf, current.ID)
			if err != nil {
				return err
			}
			return printJSON(updated)
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "New name")
	cmd.Flags().StringArrayVar(&credentialFlags, "credential", nil, credentialFlagUsage+"; replaces them all")
	return cmd
}

func newEndpointKeyCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "key <endpoint_id_or_name>",
		Short: "Issue another key for an endpoint",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			endpoint, err := findPersonalEndpoint(cmd, gf, args[0])
			if err != nil {
				return err
			}
			var resp struct {
				Key string `json:"key"`
			}
			if err := linkRequest(cmd, gf, http.MethodPost, "/v1/link/grants/"+url.PathEscape(endpoint.ID)+"/keys", nil, &resp); err != nil {
				return err
			}
			apiURL, err := gf.resolveAPIURL()
			if err != nil {
				return err
			}
			printEndpointAccess(cmd.OutOrStdout(), activityBaseURL(apiURL), resp.Key)
			return nil
		},
	}
}

func newEndpointDeleteCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "delete <endpoint_id_or_name>",
		Short: "Delete an endpoint; apps using its keys stop working",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			endpoint, err := findPersonalEndpoint(cmd, gf, args[0])
			if err != nil {
				return err
			}
			if err := linkRequest(cmd, gf, http.MethodDelete, "/v1/link/grants/"+url.PathEscape(endpoint.ID), nil, nil); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Deleted %s\n", endpoint.Name)
			return nil
		},
	}
}

// findPersonalEndpoint finds one of your endpoints by id or name.
func findPersonalEndpoint(cmd *cobra.Command, gf *globalFlags, ref string) (personalEndpoint, error) {
	var resp struct {
		Grants []personalEndpoint `json:"grants"`
	}
	if err := linkRequest(cmd, gf, http.MethodGet, "/v1/link/grants", nil, &resp); err != nil {
		return personalEndpoint{}, err
	}
	for _, grant := range resp.Grants {
		if grant.Endpoint && (grant.ID == ref || grant.Name == ref) {
			return grant, nil
		}
	}
	return personalEndpoint{}, fmt.Errorf("no endpoint %q; see `dari endpoint list`", ref)
}

func nonNilLimits(limits []personalEndpointCredential) []personalEndpointCredential {
	if limits == nil {
		return []personalEndpointCredential{}
	}
	return limits
}

// printEndpointAccess prints what the app's endpoint card shows: the base URLs
// every endpoint shares, and this endpoint's key, shown once.
func printEndpointAccess(out io.Writer, routingURL, key string) {
	fmt.Fprintf(out, "OpenAI Base URL:     %s/v1\n", routingURL)
	fmt.Fprintf(out, "Anthropic Base URL:  %s\n", routingURL)
	fmt.Fprintf(out, "API Key:             %s  (Shown Once)\n", key)
}
