package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func newProviderCredentialsCmd(gf *globalFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "provider",
		Short: "Hosted only: manage provider credentials for routers and custom models",
	}
	cmd.AddCommand(
		newProviderCredentialAddCmd(gf),
		newProviderCredentialUpdateCmd(gf),
		newProviderCredentialRemoveCmd(gf),
	)
	return cmd
}

type providerCredentialSecretFlags struct {
	valueStdin      bool
	azureEndpoint   string
	awsRegion       string
	awsRoleARN      string
	accessKeyIDEnv  string
	secretKeyEnv    string
	sessionTokenEnv string
}

func (flags *providerCredentialSecretFlags) register(cmd *cobra.Command) {
	cmd.Flags().BoolVar(&flags.valueStdin, "value-stdin", false, "Read an API key from standard input")
	cmd.Flags().StringVar(&flags.azureEndpoint, "azure-endpoint", "", "Microsoft Azure resource endpoint, for example https://my-resource.services.ai.azure.com")
	cmd.Flags().StringVar(&flags.awsRegion, "aws-region", "", "AWS region for Bedrock AWS IAM or AWS Role authentication")
	cmd.Flags().StringVar(&flags.awsRoleARN, "aws-role-arn", "", "IAM role ARN Dari assumes for Bedrock requests (AWS Role authentication)")
	cmd.Flags().StringVar(&flags.accessKeyIDEnv, "aws-access-key-id-env", "", "Environment variable containing the AWS access key ID")
	cmd.Flags().StringVar(&flags.secretKeyEnv, "aws-secret-access-key-env", "", "Environment variable containing the AWS secret access key")
	cmd.Flags().StringVar(&flags.sessionTokenEnv, "aws-session-token-env", "", "Optional environment variable containing an AWS session token")
}

func (flags *providerCredentialSecretFlags) usingStaticKeys() bool {
	return strings.TrimSpace(flags.accessKeyIDEnv) != "" ||
		strings.TrimSpace(flags.secretKeyEnv) != "" ||
		strings.TrimSpace(flags.sessionTokenEnv) != ""
}

func (flags *providerCredentialSecretFlags) auth(label string, explicitValue *string) (map[string]string, error) {
	roleARN := strings.TrimSpace(flags.awsRoleARN)
	usingAWS := strings.TrimSpace(flags.awsRegion) != "" || roleARN != "" || flags.usingStaticKeys()
	azureEndpoint := strings.TrimSpace(flags.azureEndpoint)
	if azureEndpoint != "" && usingAWS {
		return nil, errors.New("--azure-endpoint cannot be combined with AWS flags")
	}
	if !usingAWS {
		value, err := resolveCredentialValue(label, explicitValue, flags.valueStdin)
		if err != nil {
			return nil, err
		}
		if azureEndpoint != "" {
			return map[string]string{"type": "azure_api_key", "api_key": value, "endpoint": azureEndpoint}, nil
		}
		return map[string]string{"type": "api_key", "api_key": value}, nil
	}
	if explicitValue != nil || flags.valueStdin {
		return nil, errors.New("API key VALUE and --value-stdin cannot be combined with AWS flags")
	}
	region := strings.TrimSpace(flags.awsRegion)
	if region == "" {
		return nil, errors.New("--aws-region is required for AWS credentials")
	}
	if roleARN != "" {
		if flags.usingStaticKeys() {
			return nil, errors.New("--aws-role-arn cannot be combined with AWS access key flags")
		}
		return map[string]string{
			"type":     "aws_assume_role",
			"region":   region,
			"role_arn": roleARN,
		}, nil
	}
	accessKeyID, err := credentialEnvValue("--aws-access-key-id-env", flags.accessKeyIDEnv)
	if err != nil {
		return nil, err
	}
	secretKey, err := credentialEnvValue("--aws-secret-access-key-env", flags.secretKeyEnv)
	if err != nil {
		return nil, err
	}
	auth := map[string]string{
		"type":              "aws_sigv4",
		"region":            region,
		"access_key_id":     accessKeyID,
		"secret_access_key": secretKey,
	}
	if strings.TrimSpace(flags.sessionTokenEnv) != "" {
		sessionToken, err := credentialEnvValue("--aws-session-token-env", flags.sessionTokenEnv)
		if err != nil {
			return nil, err
		}
		auth["session_token"] = sessionToken
	}
	return auth, nil
}

func credentialEnvValue(flagName, envName string) (string, error) {
	envName = strings.TrimSpace(envName)
	if envName == "" {
		return "", fmt.Errorf("%s is required for AWS IAM credentials", flagName)
	}
	value := os.Getenv(envName)
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s references unset or empty environment variable %s", flagName, envName)
	}
	return value, nil
}

func newProviderCredentialAddCmd(gf *globalFlags) *cobra.Command {
	flags := &providerCredentialSecretFlags{}
	cmd := &cobra.Command{
		Use:   "add <provider> <label> [api_key]",
		Short: "Save an API key, Microsoft Azure, AWS IAM, or AWS Role credential",
		Args:  cobra.RangeArgs(2, 3),
		RunE: func(cmd *cobra.Command, args []string) error {
			gateway, err := currentGateway()
			if err != nil {
				return err
			}
			if gateway != nil {
				return errGatewayProviderKeys
			}
			var explicitValue *string
			if len(args) == 3 {
				explicitValue = &args[2]
			}
			auth, err := flags.auth(args[1], explicitValue)
			if err != nil {
				return err
			}
			body := map[string]any{
				"provider": strings.ToLower(strings.TrimSpace(args[0])),
				"label":    strings.TrimSpace(args[1]),
				"auth":     auth,
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodPost,
				"/v1/organizations/current/credentials/provider-credentials", body, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	flags.register(cmd)
	return cmd
}

func newProviderCredentialUpdateCmd(gf *globalFlags) *cobra.Command {
	flags := &providerCredentialSecretFlags{}
	cmd := &cobra.Command{
		Use:   "update <credential_id> <label> [api_key]",
		Short: "Update a saved provider credential while preserving its ID",
		Args:  cobra.RangeArgs(2, 3),
		RunE: func(cmd *cobra.Command, args []string) error {
			var explicitValue *string
			if len(args) == 3 {
				explicitValue = &args[2]
			}
			body := map[string]any{
				"label": strings.TrimSpace(args[1]),
			}
			if field, value, ok := flags.metadataOnlyUpdate(explicitValue); ok {
				body[field] = value
			} else {
				auth, err := flags.auth(args[1], explicitValue)
				if err != nil {
					return err
				}
				body["auth"] = auth
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodPut,
				"/v1/organizations/current/credentials/provider-credentials/"+url.PathEscape(args[0]), body, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	flags.register(cmd)
	return cmd
}

// metadataOnlyUpdate reports the AWS region or Azure endpoint to change when
// no secret material accompanies it; the stored secret is then kept.
func (flags *providerCredentialSecretFlags) metadataOnlyUpdate(explicitValue *string) (string, string, bool) {
	if explicitValue != nil || flags.valueStdin ||
		strings.TrimSpace(flags.awsRoleARN) != "" || flags.usingStaticKeys() {
		return "", "", false
	}
	region := strings.TrimSpace(flags.awsRegion)
	endpoint := strings.TrimSpace(flags.azureEndpoint)
	switch {
	case region != "" && endpoint == "":
		return "region", region, true
	case endpoint != "" && region == "":
		return "endpoint", endpoint, true
	}
	return "", "", false
}

func newProviderCredentialRemoveCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "remove <credential_id>",
		Short: "Delete an unreferenced saved provider credential",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodDelete,
				"/v1/organizations/current/credentials/provider-credentials/"+url.PathEscape(args[0]), nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

func newCredentialsListCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "Hosted only: list stored credentials for the current org as JSON",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var resp struct {
				Credentials []any `json:"credentials"`
			}
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/credentials", nil, &resp); err != nil {
				return err
			}
			return printJSON(map[string]any{"credentials": resp.Credentials})
		},
	}
}

// The CLI names personal subscriptions by the short provider aliases the agent
// flow uses, or by a subscription's credential name when several are connected.
var subscriptionProviders = map[string]agentSubscriptionProvider{
	"claude-code":       claudeSubscription,
	"codex":             codexSubscription,
	"grok":              grokSubscription,
	"muse-code":         museSubscription,
	"opencode-go":       opencodeGoSubscription,
	"vercel-token-pass": vercelTokenPassSubscription,
}

type subscriptionCredential struct {
	ID                string            `json:"id"`
	Name              string            `json:"name"`
	Label             *string           `json:"label"`
	SafeMetadata      map[string]string `json:"safe_metadata"`
	CredentialScope   string            `json:"credential_scope"`
	OAuthProvider     string            `json:"oauth_provider"`
	CreatedAt         string            `json:"created_at"`
	LastUsedAt        *string           `json:"last_used_at"`
	UnavailableUntil  *string           `json:"unavailable_until"`
	UnavailableReason *string           `json:"unavailable_reason"`
	// ModelHolds are models at their own usage limit while the plan still
	// serves the rest; routing skips each until its reset.
	ModelHolds         []subscriptionModelHold `json:"model_holds"`
	SubscriptionActive bool                    `json:"subscription_active"`
	// Usage is how much of its quota the plan last reported used.
	Usage *subscriptionUsage `json:"usage"`
	// place is where the plan lives when the page shows plans from both
	// hosted Dari and this computer; empty for a listing from one API.
	place subscriptionPlace
}

// subscriptionUsage is the tightest window's share used and reset, and every
// window that has not reset, shortest first.
type subscriptionUsage struct {
	Utilization float64                   `json:"utilization"`
	ResetsAt    string                    `json:"resets_at"`
	Windows     []subscriptionUsageWindow `json:"windows"`
}

// subscriptionReset is a banked limit reset of a ChatGPT or Claude Code plan.
type subscriptionReset struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Null for a reset the provider gives no end date.
	ExpiresAt *string `json:"expires_at"`
	// Usable is whether the provider would honor it now.
	Usable bool `json:"usable"`
}

// listSubscriptionResets lists a subscription's resets, and when they were
// read when the provider refused to list them now and an earlier list stands
// in ("" when they are live).
func listSubscriptionResets(ctx context.Context, client *api.Client, name string) ([]subscriptionReset, string, error) {
	var listed struct {
		Resets []subscriptionReset `json:"resets"`
		ReadAt *string             `json:"read_at"`
	}
	err := client.Do(ctx, http.MethodGet, "/v1/organizations/current/credentials/"+url.PathEscape(name)+"/resets", nil, &listed)
	readAt := ""
	if listed.ReadAt != nil {
		readAt = *listed.ReadAt
	}
	return listed.Resets, readAt, api.HumanError(err)
}

func useSubscriptionReset(ctx context.Context, client *api.Client, name, resetID string) (string, error) {
	var used struct {
		Result string `json:"result"`
	}
	err := client.Do(ctx, http.MethodPost, "/v1/organizations/current/credentials/"+url.PathEscape(name)+"/resets/"+url.PathEscape(resetID)+"/use", nil, &used)
	return used.Result, api.HumanError(err)
}

type subscriptionModelHold struct {
	Model string `json:"model"`
	// DisplayName is the model's catalog name; servers before it was added
	// send only the id.
	DisplayName      string `json:"display_name"`
	UnavailableUntil string `json:"unavailable_until"`
	Reason           string `json:"reason"`
}

type subscriptionUsageWindow struct {
	// Label is what to call the window: "5 Hour", "Weekly", "Claude Fable Weekly".
	Label       string  `json:"label"`
	ModelFamily string  `json:"model_family,omitempty"`
	Minutes     int     `json:"minutes"`
	Utilization float64 `json:"utilization"`
	ResetsAt    string  `json:"resets_at"`
}

func newSubscriptionCredentialsCmd(gf *globalFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "subscription",
		Short: "Manage your personal ChatGPT, Claude Code, Grok, Muse Code, OpenCode Go, and Vercel Token Pass subscriptions",
		Long: "Connect one or more personal subscriptions per provider. A model tries its maker's plan " +
			"first, then the user's other plans that serve it. Of each kind, routing uses the active one " +
			"until it reaches its usage limit, then holds it until its reset and switches to the next " +
			"one in connection order.",
	}
	cmd.AddCommand(
		newSubscriptionListCmd(gf),
		newSubscriptionConnectCmd(gf),
		newPlacedSubscriptionCmd(gf, "mark-available", "Clear a subscription's usage-limit holds, its own and its models', so routers can use it again",
			http.MethodPost, func(name string) string { return url.PathEscape(name) + "/mark-available" }, nil),
		newPlacedSubscriptionCmd(gf, "disconnect", "Disconnect a subscription, on Cloud or Local",
			http.MethodDelete, func(name string) string { return url.PathEscape(name) + "?scope=user" }, nil),
		newSubscriptionResetsCmd(gf),
		newSubscriptionUseResetCmd(gf),
		newSubscriptionRenameCmd(gf),
	)
	return cmd
}

func newSubscriptionListCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List your subscriptions in connection order, with where each lives, which is active, and which are held",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			selfHosted, err := selfHostedGateway()
			if err != nil {
				return err
			}
			var placed []placedSubscription
			if selfHosted {
				subscriptions, err := listSubscriptionCredentials(cmd, gf)
				if err != nil {
					return err
				}
				for _, subscription := range subscriptions {
					placed = append(placed, placedSubscription{subscription, "", "Gateway"})
				}
			} else if placed, err = listPlacedSubscriptions(cmd.Context(), gf, cmd.ErrOrStderr(), true); err != nil {
				return err
			}
			rows := make([]map[string]any, 0, len(placed))
			for _, p := range placed {
				subscription := p.subscriptionCredential
				rows = append(rows, map[string]any{
					"name":               subscription.Name,
					"provider":           subscriptionAlias(subscription.OAuthProvider),
					"where":              p.where,
					"label":              subscription.Label,
					"account_email":      subscription.SafeMetadata["account_email"],
					"plan":               subscription.SafeMetadata["plan"],
					"workspace_name":     subscription.SafeMetadata["workspace_name"],
					"renews_at":          subscription.SafeMetadata["renews_at"],
					"status":             subscriptionStatus(subscription),
					"unavailable_until":  subscription.UnavailableUntil,
					"unavailable_reason": subscription.UnavailableReason,
					"model_holds":        activeModelHolds(subscription, time.Now()),
					"last_used_at":       subscription.LastUsedAt,
					"usage":              subscription.Usage,
					// Where the plan itself is managed, at its vendor.
					"manage_url": subscriptionProviderFor(subscription.OAuthProvider).billingURL,
				})
			}
			return printJSON(map[string]any{"subscriptions": rows})
		},
	}
}

func newSubscriptionConnectCmd(gf *globalFlags) *cobra.Command {
	var reconnect, on string
	cmd := &cobra.Command{
		Use:   "connect <codex|claude-code|grok|muse-code|opencode-go|vercel-token-pass>",
		Short: "Connect another subscription, or reconnect one with --reconnect",
		Long: "Connects a subscription on Cloud (hosted Dari) or Local (this computer, Activity synced to Dari).\n" +
			"A plan of the same provider already on Cloud or Local is first offered to move there,\n" +
			"since one account may be connected on Cloud once and Local once.\n" +
			"To keep this computer's requests out of Activity, run `dari private on`.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			provider, ok := subscriptionProviders[strings.ToLower(strings.TrimSpace(args[0]))]
			if !ok {
				return fmt.Errorf("unknown subscription %q: expected codex, claude-code, grok, muse-code, opencode-go, or vercel-token-pass", args[0])
			}
			viaGateway, err := routesThroughGateway()
			if err != nil {
				return err
			}
			if !viaGateway && reconnect == "" {
				place, err := chooseSubscriptionPlace(cmd.InOrStdin(), cmd.ErrOrStderr(), provider, on)
				if err != nil {
					return err
				}
				return connectOrMove(cmd.Context(), gf, provider, place, cmd.InOrStdin(), cmd.ErrOrStderr())
			}
			if !viaGateway {
				// A plan reconnects where it lives; --on picks between Dari
				// and this computer when the name is in both.
				client, name, err := placedSubscriptionClient(cmd, gf, reconnect, on)
				if err != nil {
					return err
				}
				return connectAgentPersonalSubscription(cmd.Context(), provider, client, cmd.InOrStdin(), cmd.ErrOrStderr(), name)
			}
			if on != "" {
				return errNoPlaces
			}
			client, err := subscriptionClient(cmd.Context(), gf, cmd.ErrOrStderr())
			if err != nil {
				return err
			}
			return connectAgentPersonalSubscription(cmd.Context(), provider, client,
				cmd.InOrStdin(), cmd.ErrOrStderr(), strings.ToUpper(strings.TrimSpace(reconnect)))
		},
	}
	cmd.Flags().StringVar(&reconnect, "reconnect", "", "credential name of the subscription to reconnect (see `subscription list`)")
	cmd.Flags().StringVar(&on, "on", "", "where the plan lives: cloud or local (Activity synced to Dari); omit for the menu. With --reconnect: cloud or local, when the name is in both")
	return cmd
}

func newSubscriptionRenameCmd(gf *globalFlags) *cobra.Command {
	cmd := newPlacedSubscriptionCmd(gf, "rename", "Give a subscription your own name; an empty label clears it",
		http.MethodPut, func(name string) string { return url.PathEscape(name) + "/label" },
		func(args []string) any { return map[string]string{"label": strings.TrimSpace(args[1])} })
	cmd.Use = "rename <claude-code|codex|NAME> <label>"
	cmd.Args = cobra.ExactArgs(2)
	return cmd
}

// newPlacedSubscriptionCmd acts on one plan where it lives: on hosted Dari, on
// this computer's gateway, or on a self-hosted gateway.
func newPlacedSubscriptionCmd(gf *globalFlags, use, short, method string, path func(name string) string, body func(args []string) any) *cobra.Command {
	var on string
	cmd := &cobra.Command{
		Use:   use + " <claude-code|codex|NAME>",
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var payload any
			if body != nil {
				payload = body(args)
			}
			client, name, err := placedSubscriptionClient(cmd, gf, args[0], on)
			if err != nil {
				return err
			}
			var resp map[string]any
			if err := client.Do(cmd.Context(), method, "/v1/organizations/current/credentials/"+path(name), payload, &resp); err != nil {
				return api.HumanError(err)
			}
			return printJSON(resp)
		},
	}
	cmd.Flags().StringVar(&on, "on", "", "cloud or local, when the name is connected in both")
	return cmd
}

// placedSubscriptionClient finds the plan an argument names wherever it
// lives, and the API that manages it there.
func placedSubscriptionClient(cmd *cobra.Command, gf *globalFlags, arg, on string) (*api.Client, string, error) {
	selfHosted, err := selfHostedGateway()
	if err != nil {
		return nil, "", err
	}
	if selfHosted {
		name, err := resolveSubscriptionName(cmd, gf, arg)
		if err != nil {
			return nil, "", err
		}
		client, err := subscriptionClient(cmd.Context(), gf, cmd.ErrOrStderr())
		return client, name, err
	}
	all, err := listPlacedSubscriptions(cmd.Context(), gf, cmd.ErrOrStderr(), false)
	if err != nil {
		return nil, "", err
	}
	found, err := findPlacedSubscription(all, arg, on)
	if err != nil {
		return nil, "", err
	}
	client, err := placedClient(cmd.Context(), gf, found, cmd.ErrOrStderr())
	return client, found.Name, err
}

// resolveSubscriptionName maps a provider alias to its only connected
// subscription; with several connected, the caller must name one.
func resolveSubscriptionName(cmd *cobra.Command, gf *globalFlags, arg string) (string, error) {
	provider, ok := subscriptionProviders[strings.ToLower(strings.TrimSpace(arg))]
	if !ok {
		return strings.ToUpper(strings.TrimSpace(arg)), nil
	}
	subscriptions, err := listSubscriptionCredentials(cmd, gf)
	if err != nil {
		return "", err
	}
	var names []string
	for _, subscription := range subscriptions {
		if subscription.OAuthProvider == provider.id {
			names = append(names, subscription.Name)
		}
	}
	switch len(names) {
	case 0:
		return "", fmt.Errorf("no %s subscription is connected", provider.name)
	case 1:
		return names[0], nil
	}
	return "", fmt.Errorf("%d %s subscriptions are connected; pass one of: %s",
		len(names), provider.name, strings.Join(names, ", "))
}

func listSubscriptionCredentials(cmd *cobra.Command, gf *globalFlags) ([]subscriptionCredential, error) {
	var resp struct {
		Credentials []subscriptionCredential `json:"credentials"`
	}
	// As the Accounts page does: usage that is read only on request is read again when stale.
	if err := subscriptionRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/credentials?refresh_usage=true", nil, &resp); err != nil {
		return nil, err
	}
	return personalSubscriptions(resp.Credentials), nil
}

// personalSubscriptions keeps the user's subscriptions, in connection order
// per provider, which is the order routing switches through.
func personalSubscriptions(credentials []subscriptionCredential) []subscriptionCredential {
	subscriptions := slices.DeleteFunc(credentials, func(c subscriptionCredential) bool {
		return c.CredentialScope != "user" || c.OAuthProvider == ""
	})
	slices.SortStableFunc(subscriptions, func(a, b subscriptionCredential) int {
		if c := strings.Compare(a.OAuthProvider, b.OAuthProvider); c != 0 {
			return c
		}
		return strings.Compare(a.CreatedAt, b.CreatedAt)
	})
	return subscriptions
}

func subscriptionAlias(oauthProvider string) string {
	for alias, provider := range subscriptionProviders {
		if provider.id == oauthProvider {
			return alias
		}
	}
	return oauthProvider
}

// activeModelHolds is the subscription's model holds that have not reset.
func activeModelHolds(subscription subscriptionCredential, now time.Time) []subscriptionModelHold {
	holds := []subscriptionModelHold{}
	for _, hold := range subscription.ModelHolds {
		if until, err := time.Parse(time.RFC3339Nano, hold.UnavailableUntil); err == nil && until.After(now) {
			holds = append(holds, hold)
		}
	}
	return holds
}

func subscriptionStatus(subscription subscriptionCredential) string {
	if subscription.UnavailableUntil != nil {
		until, err := time.Parse(time.RFC3339Nano, *subscription.UnavailableUntil)
		if err == nil && until.After(time.Now()) {
			return "held"
		}
	}
	if subscription.SubscriptionActive {
		return "active"
	}
	return "standby"
}

// resolveCredentialValue mirrors the Python CLI's logic: positional value,
// --value-stdin, or a secure prompt — exactly one must produce a non-empty
// string.
func resolveCredentialValue(name string, explicit *string, useStdin bool) (string, error) {
	if explicit != nil && useStdin {
		return "", errors.New("pass either VALUE or --value-stdin, not both")
	}
	switch {
	case useStdin:
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", fmt.Errorf("read stdin: %w", err)
		}
		v := strings.TrimRight(string(data), "\r\n")
		if v == "" {
			return "", errors.New("credential value must be non-empty")
		}
		return v, nil
	case explicit != nil:
		fmt.Fprintln(os.Stderr, "Warning: passing credential values on the command line can expose them via shell history and process arguments.")
		if *explicit == "" {
			return "", errors.New("credential value must be non-empty")
		}
		return *explicit, nil
	default:
		fmt.Fprintf(os.Stderr, "%s: ", name)
		raw, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			// Fallback for non-TTY stdin (e.g. piped input without --value-stdin).
			line, rerr := bufio.NewReader(os.Stdin).ReadString('\n')
			if rerr != nil && rerr != io.EOF {
				return "", rerr
			}
			raw = []byte(strings.TrimRight(line, "\r\n"))
		}
		if len(raw) == 0 {
			return "", errors.New("credential value must be non-empty")
		}
		return string(raw), nil
	}
}

func newSubscriptionResetsCmd(gf *globalFlags) *cobra.Command {
	return newPlacedSubscriptionCmd(gf, "resets", "List a ChatGPT or Claude Code subscription's banked limit resets, the soonest to expire first",
		http.MethodGet, func(name string) string { return url.PathEscape(name) + "/resets" }, nil)
}

func newSubscriptionUseResetCmd(gf *globalFlags) *cobra.Command {
	var on string
	cmd := &cobra.Command{
		Use:   "use-reset <codex|claude-code|NAME> [RESET_ID]",
		Short: "Spend one banked limit reset now; without RESET_ID, the usable one that expires first",
		Long: "Spend one banked limit reset now, clearing the subscription's usage limits. " +
			"The result is the provider's answer: \"reset\" when it reset the plan; otherwise the reset is " +
			"usually kept (for example \"nothing_to_reset\" when the plan is not at a limit).",
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, name, err := placedSubscriptionClient(cmd, gf, args[0], on)
			if err != nil {
				return err
			}
			resetID := ""
			if len(args) == 2 {
				resetID = strings.TrimSpace(args[1])
			} else {
				resets, _, err := listSubscriptionResets(cmd.Context(), client, name)
				if err != nil {
					return err
				}
				usable := slices.IndexFunc(resets, func(r subscriptionReset) bool { return r.Usable })
				if usable < 0 {
					return fmt.Errorf("%s has no banked reset it can use now", name)
				}
				resetID = resets[usable].ID
			}
			result, err := useSubscriptionReset(cmd.Context(), client, name, resetID)
			if err != nil {
				return err
			}
			return printJSON(map[string]string{"result": result})
		},
	}
	cmd.Flags().StringVar(&on, "on", "", "cloud or local, when the name is connected in both")
	return cmd
}
