package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		cmd := &cobra.Command{Use: "credentials", Short: "Manage provider credentials and subscriptions for the current org"}
		cmd.AddCommand(
			newCredentialsListCmd(gf),
			newProviderCredentialsCmd(gf),
			newSubscriptionCredentialsCmd(gf),
		)
		root.AddCommand(cmd)
	})
}

func newProviderCredentialsCmd(gf *globalFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "provider",
		Short: "Manage saved provider credentials for routers and custom models",
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
			gateway, err := gatewayFromEnv()
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
		Short: "List stored credentials for the current org",
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
	"claude-code": claudeSubscription,
	"codex":       codexSubscription,
	"muse-code":   museSubscription,
}

type subscriptionCredential struct {
	Name               string            `json:"name"`
	Label              *string           `json:"label"`
	SafeMetadata       map[string]string `json:"safe_metadata"`
	CredentialScope    string            `json:"credential_scope"`
	OAuthProvider      string            `json:"oauth_provider"`
	CreatedAt          string            `json:"created_at"`
	LastUsedAt         *string           `json:"last_used_at"`
	UnavailableUntil   *string           `json:"unavailable_until"`
	UnavailableReason  *string           `json:"unavailable_reason"`
	SubscriptionActive bool              `json:"subscription_active"`
	AutoRedeemResets   bool              `json:"auto_redeem_resets"`
}

func newSubscriptionCredentialsCmd(gf *globalFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "subscription",
		Short: "Manage your personal Claude Code, ChatGPT, and Muse Code subscriptions",
		Long: "Connect one or more personal subscriptions per provider. Routing uses the active one " +
			"until it reaches its usage limit, then holds it until its reset and switches to the next " +
			"one in connection order.",
	}
	cmd.AddCommand(
		newSubscriptionListCmd(gf),
		newSubscriptionConnectCmd(gf),
		newSubscriptionCredentialCmd(gf, "mark-available", "Clear a usage-limit hold so routers can use the subscription again",
			http.MethodPost, func(name string) string { return url.PathEscape(name) + "/mark-available" }),
		newSubscriptionCredentialCmd(gf, "disconnect", "Disconnect a subscription from Dari",
			http.MethodDelete, func(name string) string { return url.PathEscape(name) + "?scope=user" }),
		newSubscriptionAutoResetCmd(gf),
		newSubscriptionRenameCmd(gf),
	)
	return cmd
}

func newSubscriptionListCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List your subscriptions in connection order, with which is active and which are held",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			subscriptions, err := listSubscriptionCredentials(cmd, gf)
			if err != nil {
				return err
			}
			rows := make([]map[string]any, 0, len(subscriptions))
			for _, subscription := range subscriptions {
				rows = append(rows, map[string]any{
					"name":               subscription.Name,
					"provider":           subscriptionAlias(subscription.OAuthProvider),
					"label":              subscription.Label,
					"account_email":      subscription.SafeMetadata["account_email"],
					"status":             subscriptionStatus(subscription),
					"unavailable_until":  subscription.UnavailableUntil,
					"unavailable_reason": subscription.UnavailableReason,
					"last_used_at":       subscription.LastUsedAt,
					"auto_redeem_resets": subscription.AutoRedeemResets,
				})
			}
			return printJSON(map[string]any{"subscriptions": rows})
		},
	}
}

func newSubscriptionConnectCmd(gf *globalFlags) *cobra.Command {
	var reconnect string
	cmd := &cobra.Command{
		Use:   "connect <claude-code|codex>",
		Short: "Connect another subscription, or reconnect one with --reconnect",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			provider, ok := subscriptionProviders[strings.ToLower(strings.TrimSpace(args[0]))]
			if !ok {
				return fmt.Errorf("unknown subscription %q: expected claude-code, codex, or muse-code", args[0])
			}
			client, err := subscriptionClient(gf)
			if err != nil {
				return err
			}
			return connectAgentPersonalSubscription(cmd.Context(), provider, client,
				cmd.InOrStdin(), cmd.ErrOrStderr(), strings.ToUpper(strings.TrimSpace(reconnect)))
		},
	}
	cmd.Flags().StringVar(&reconnect, "reconnect", "", "credential name of the subscription to reconnect (see `subscription list`)")
	return cmd
}

func newSubscriptionCredentialCmd(gf *globalFlags, use, short, method string, path func(name string) string) *cobra.Command {
	return &cobra.Command{
		Use:   use + " <claude-code|codex|NAME>",
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name, err := resolveSubscriptionName(cmd, gf, args[0])
			if err != nil {
				return err
			}
			var resp map[string]any
			if err := subscriptionRequest(cmd, gf, method,
				"/v1/organizations/current/credentials/"+path(name), nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

func newSubscriptionAutoResetCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "auto-reset <codex|NAME> <on|off>",
		Short: "Let Dari spend a ChatGPT subscription's banked Codex resets when every ChatGPT subscription is exhausted",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			var enabled bool
			switch strings.ToLower(strings.TrimSpace(args[1])) {
			case "on":
				enabled = true
			case "off":
			default:
				return fmt.Errorf("expected on or off, got %q", args[1])
			}
			// Banked resets are a hosted-billing feature the gateway does not serve.
			gateway, err := gatewayFromEnv()
			if err != nil {
				return err
			}
			if gateway != nil {
				return fmt.Errorf("auto-reset is only available on the hosted Dari API; it is not supported with %s", gatewayURLEnv)
			}
			name, err := resolveSubscriptionName(cmd, gf, args[0])
			if err != nil {
				return err
			}
			var resp map[string]any
			if err := subscriptionRequest(cmd, gf, http.MethodPut,
				"/v1/organizations/current/credentials/"+url.PathEscape(name)+"/auto-reset",
				map[string]bool{"enabled": enabled}, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

func newSubscriptionRenameCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "rename <claude-code|codex|NAME> <label>",
		Short: "Give a subscription your own name; an empty label clears it",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			name, err := resolveSubscriptionName(cmd, gf, args[0])
			if err != nil {
				return err
			}
			var resp map[string]any
			if err := subscriptionRequest(cmd, gf, http.MethodPut,
				"/v1/organizations/current/credentials/"+url.PathEscape(name)+"/label",
				map[string]string{"label": strings.TrimSpace(args[1])}, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
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
	if err := subscriptionRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/credentials", nil, &resp); err != nil {
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
