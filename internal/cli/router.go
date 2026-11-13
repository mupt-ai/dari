package cli

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		cmd := &cobra.Command{
			Use:     "router",
			Aliases: []string{"routers"},
			Short:   "Hosted only: manage Dari Routers for the current org",
		}
		cmd.AddCommand(
			newRouterListCmd(gf),
			newRouterGetCmd(gf),
			newRouterModelsCmd(gf),
			newRouterRequestCostsCmd(),
			newRouterCreateCmd(gf),
			newRouterUpdateCmd(gf),
			newRouterAssignAgentCmd(gf),
			newRouterDeleteCmd(gf),
		)
		root.AddCommand(cmd)
	})
}

func newRouterListCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List routers for the current org",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/routers", nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

func newRouterGetCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "get <router_id_or_endpoint>",
		Short: "Show one router for the current org",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			routerID, err := normalizeRouterID(args[0])
			if err != nil {
				return err
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/routers/"+url.PathEscape(routerID), nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

func newRouterModelsCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "models",
		Short: "List models available for router selection, grouped by provider",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/routers/model-catalog", nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

type routerCustomRule struct {
	When          string  `json:"when" yaml:"when"`
	Use           string  `json:"use" yaml:"use"`
	ThinkingLevel *string `json:"thinking_level,omitempty" yaml:"thinking_level"`
}

type routerCustomConfig struct {
	Rules                []routerCustomRule `json:"rules" yaml:"rules"`
	Default              *string            `json:"default,omitempty" yaml:"default"`
	DefaultThinkingLevel *string            `json:"default_thinking_level,omitempty" yaml:"default_thinking_level"`
}

type routerCreateRequest struct {
	AllowLongContext      bool                `json:"allow_long_context,omitempty"`
	EvalScoreImputation   *bool               `json:"eval_score_imputation,omitempty"`
	SessionPinning        bool                `json:"session_pinning,omitempty"`
	NativeCompaction      bool                `json:"native_compaction,omitempty"`
	Name                  string              `json:"name"`
	EnabledModels         []string            `json:"enabled_models"`
	ModelProviders        map[string]string   `json:"model_providers,omitempty"`
	ProviderKeys          map[string]string   `json:"provider_keys,omitempty"`
	ProviderCredentialIDs map[string]string   `json:"provider_credential_ids,omitempty"`
	ProviderKeySources    map[string]string   `json:"provider_key_sources,omitempty"`
	RoutingStrategy       string              `json:"routing_strategy,omitempty"`
	CustomConfig          *routerCustomConfig `json:"custom_config,omitempty"`
	ModelThinkingLevels   map[string][]string `json:"model_thinking_levels,omitempty"`
	FastModels            []string            `json:"fast_models,omitempty"`
	// Providers served by the attributed user's subscription, and the models
	// that keep running on the provider's API credential while it is unavailable.
	SubscriptionProviders         []string `json:"subscription_providers,omitempty"`
	SubscriptionAPIFallbackModels []string `json:"subscription_api_fallback_models,omitempty"`
}

type routerUpdateRequest struct {
	AllowLongContext      *bool             `json:"allow_long_context,omitempty"`
	EvalScoreImputation   *bool             `json:"eval_score_imputation,omitempty"`
	SessionPinning        *bool             `json:"session_pinning,omitempty"`
	NativeCompaction      *bool             `json:"native_compaction,omitempty"`
	Name                  string            `json:"name"`
	EnabledModels         []string          `json:"enabled_models"`
	ProviderKeys          map[string]string `json:"provider_keys,omitempty"`
	ProviderCredentialIDs map[string]string `json:"provider_credential_ids,omitempty"`
	ProviderKeySources    map[string]string `json:"provider_key_sources,omitempty"`
	RoutingStrategy       string            `json:"routing_strategy,omitempty"`
	// Omitted keeps the current list; an empty list clears it.
	SubscriptionProviders         *[]string `json:"subscription_providers,omitempty"`
	SubscriptionAPIFallbackModels *[]string `json:"subscription_api_fallback_models,omitempty"`
}

type routerCurrent struct {
	Name            string   `json:"name"`
	EnabledModels   []string `json:"enabled_models"`
	RoutingStrategy string   `json:"routing_strategy"`
}

type routerCreateManifest struct {
	AllowLongContext              bool                `yaml:"allow_long_context"`
	EvalScoreImputation           *bool               `yaml:"eval_score_imputation"`
	SessionPinning                bool                `yaml:"session_pinning"`
	NativeCompaction              bool                `yaml:"native_compaction"`
	Name                          string              `yaml:"name"`
	EnabledModels                 []string            `yaml:"enabled_models"`
	ModelProviders                map[string]string   `yaml:"model_providers"`
	ProviderKeys                  map[string]string   `yaml:"provider_keys"`
	ProviderKeyEnvs               map[string]string   `yaml:"provider_key_envs"`
	ProviderCredentialIDs         map[string]string   `yaml:"provider_credential_ids"`
	ProviderKeySources            map[string]string   `yaml:"provider_key_sources"`
	RoutingStrategy               string              `yaml:"routing_strategy"`
	CustomConfig                  *routerCustomConfig `yaml:"custom_config"`
	ModelThinkingLevels           map[string][]string `yaml:"model_thinking_levels"`
	FastModels                    []string            `yaml:"fast_models"`
	SubscriptionProviders         []string            `yaml:"subscription_providers"`
	SubscriptionAPIFallbackModels []string            `yaml:"subscription_api_fallback_models"`
}

type routerConfigFlags struct {
	allowLongContext      bool
	evalScoreImputation   bool
	sessionPinning        bool
	nativeCompaction      bool
	models                []string
	subscriptionProviders []string
	apiFallbackModels     []string
	providerKeyPairs      []string
	providerKeyEnvs       []string
	providerCredentials   []string
	managedKeyProvider    []string
	strategy              string
	flagNames             []string
}

func (rf *routerConfigFlags) register(cmd *cobra.Command) {
	// name records every registered flag so changed() below cannot drift
	// from the set of flags this struct owns.
	name := func(flagName string) string {
		rf.flagNames = append(rf.flagNames, flagName)
		return flagName
	}
	cmd.Flags().StringSliceVar(&rf.models, name("model"), nil, "Enabled model ID (repeatable or comma-separated); run 'dari router models' for the catalog")
	cmd.Flags().StringArrayVar(&rf.providerKeyPairs, name("provider-key"), nil, "Provider API key as provider=KEY, e.g. fireworks=sk-... (repeatable)")
	cmd.Flags().StringArrayVar(&rf.providerKeyEnvs, name("provider-key-env"), nil, "Read a provider API key from the local environment as provider=ENV_VAR (repeatable)")
	cmd.Flags().StringArrayVar(&rf.providerCredentials, name("provider-credential"), nil, "Use a saved provider credential as provider=CREDENTIAL_ID (repeatable)")
	cmd.Flags().StringSliceVar(&rf.managedKeyProvider, name("managed-key"), nil, "Use the Dari-managed key for this provider (repeatable or comma-separated)")
	cmd.Flags().StringVar(&rf.strategy, name("strategy"), "", "Routing strategy: dari; use a manifest for custom rules")
	cmd.Flags().BoolVar(&rf.allowLongContext, name("allow-long-context"), false, "Allow provider long-context surcharges (off by default)")
	cmd.Flags().BoolVar(&rf.evalScoreImputation, name("eval-score-imputation"), true, "Estimate missing eval scores for a model and thinking level from related measured scores (on by default)")
	cmd.Flags().BoolVar(&rf.sessionPinning, name("session-pinning"), false, "Route once when a session starts and keep that model for the whole session; each subagent is routed once when it starts (off by default)")
	cmd.Flags().BoolVar(&rf.nativeCompaction, name("native-compaction"), false, "Let Codex compact context server-side with the provider's native compaction; requests carrying compaction state are routed only to models that support it (off by default)")
	cmd.Flags().StringSliceVar(&rf.subscriptionProviders, name("subscription"), nil, "Serve this provider's models from the attributed user's personal subscription: openai, anthropic, or meta (repeatable or comma-separated). The provider's --provider-credential or --managed-key choice becomes its API fallback credential. On update this replaces the list; an empty value clears it")
	cmd.Flags().StringSliceVar(&rf.apiFallbackModels, name("api-fallback"), nil, "Keep this subscription model running on the provider's API credential while the subscription is unavailable; models without it pause until the subscription is back (repeatable or comma-separated). On update this replaces the list; an empty value clears it")
}

// subscriptionSettings returns the subscription lists, nil when their flag
// was not passed so update keeps the router's current list.
func (rf *routerConfigFlags) subscriptionSettings(cmd *cobra.Command) (providers, apiFallbackModels *[]string, err error) {
	if cmd.Flags().Changed("subscription") {
		cleaned := []string{}
		for _, provider := range rf.subscriptionProviders {
			provider = strings.ToLower(strings.TrimSpace(provider))
			if provider == "" {
				continue
			}
			if !isSubscriptionRouterProvider(provider) {
				return nil, nil, fmt.Errorf("--subscription %s: subscriptions serve openai, anthropic, or meta", provider)
			}
			cleaned = append(cleaned, provider)
		}
		providers = &cleaned
	}
	if cmd.Flags().Changed("api-fallback") {
		cleaned := []string{}
		for _, model := range rf.apiFallbackModels {
			if model = strings.TrimSpace(model); model != "" {
				cleaned = append(cleaned, model)
			}
		}
		apiFallbackModels = &cleaned
	}
	return providers, apiFallbackModels, nil
}

func (rf *routerConfigFlags) changed(cmd *cobra.Command) bool {
	return slices.ContainsFunc(rf.flagNames, cmd.Flags().Changed)
}

func (rf *routerConfigFlags) providerKeys(stderr io.Writer) (map[string]string, error) {
	keys := map[string]string{}
	for _, pair := range rf.providerKeyPairs {
		provider, value, err := splitPair(pair, "--provider-key", "provider=KEY")
		if err != nil {
			return nil, err
		}
		provider = strings.ToLower(provider)
		fmt.Fprintln(stderr, "Warning: passing provider keys on the command line can expose them via shell history and process arguments; prefer --provider-key-env.")
		keys[provider] = value
	}
	for _, pair := range rf.providerKeyEnvs {
		provider, envName, err := splitPair(pair, "--provider-key-env", "provider=ENV_VAR")
		if err != nil {
			return nil, err
		}
		provider = strings.ToLower(provider)
		value := os.Getenv(envName)
		if strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("--provider-key-env %s: environment variable %s is empty or unset", pair, envName)
		}
		keys[provider] = value
	}
	return keys, nil
}

func (rf *routerConfigFlags) providerKeySources() map[string]string {
	if len(rf.managedKeyProvider) == 0 {
		return nil
	}
	sources := map[string]string{}
	for _, provider := range rf.managedKeyProvider {
		sources[strings.ToLower(strings.TrimSpace(provider))] = "managed"
	}
	return sources
}

func (rf *routerConfigFlags) providerCredentialIDs() (map[string]string, error) {
	if len(rf.providerCredentials) == 0 {
		return nil, nil
	}
	ids := map[string]string{}
	for _, pair := range rf.providerCredentials {
		provider, credentialID, err := splitPair(pair, "--provider-credential", "provider=CREDENTIAL_ID")
		if err != nil {
			return nil, err
		}
		provider = strings.ToLower(provider)
		if existing, exists := ids[provider]; exists && existing != credentialID {
			return nil, fmt.Errorf("--provider-credential defines provider %s more than once", provider)
		}
		ids[provider] = credentialID
	}
	return ids, nil
}

func newRouterCreateCmd(gf *globalFlags) *cobra.Command {
	rf := &routerConfigFlags{}
	var manifestPath string
	cmd := &cobra.Command{
		Use:   "create <name_or_manifest_path>",
		Short: "Create a router for the current org",
		Args: func(cmd *cobra.Command, args []string) error {
			if cmd.Flags().Changed("from-file") {
				if len(args) > 0 {
					return fmt.Errorf("--from-file cannot be combined with a positional name or manifest path")
				}
				return nil
			}
			return cobra.ExactArgs(1)(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if cmd.Flags().Changed("from-file") {
				if rf.changed(cmd) {
					return fmt.Errorf("--from-file cannot be combined with router config flags; put the configuration in the manifest")
				}
				return createRouterFromManifest(cmd, gf, manifestPath)
			}
			if !rf.changed(cmd) && looksLikeRouterManifestPath(args[0]) {
				return createRouterFromManifest(cmd, gf, args[0])
			}
			if len(rf.models) == 0 {
				return fmt.Errorf("at least one --model is required; run 'dari router models' for the catalog")
			}
			body := routerCreateRequest{
				AllowLongContext: rf.allowLongContext,
				SessionPinning:   rf.sessionPinning,
				NativeCompaction: rf.nativeCompaction,
				Name:             strings.TrimSpace(args[0]),
				EnabledModels:    rf.models,
			}
			// Omitted unless passed so the API default (on) applies.
			if cmd.Flags().Changed("eval-score-imputation") {
				body.EvalScoreImputation = &rf.evalScoreImputation
			}
			subscriptionProviders, apiFallbackModels, err := rf.subscriptionSettings(cmd)
			if err != nil {
				return err
			}
			if subscriptionProviders != nil {
				body.SubscriptionProviders = *subscriptionProviders
			}
			if apiFallbackModels != nil {
				body.SubscriptionAPIFallbackModels = *apiFallbackModels
			}
			keys, err := rf.providerKeys(cmd.ErrOrStderr())
			if err != nil {
				return err
			}
			if len(keys) > 0 {
				body.ProviderKeys = keys
			}
			credentialIDs, err := rf.providerCredentialIDs()
			if err != nil {
				return err
			}
			if len(credentialIDs) > 0 {
				body.ProviderCredentialIDs = credentialIDs
			}
			sources := rf.providerKeySources()
			if err := validateProviderCredentialSelections(keys, credentialIDs, sources); err != nil {
				return err
			}
			if sources != nil {
				body.ProviderKeySources = sources
			}
			strategy, err := routerStrategyForCreate(rf.strategy)
			if err != nil {
				return err
			}
			if strategy != "" {
				body.RoutingStrategy = strategy
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodPost, "/v1/organizations/current/routers", body, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	rf.register(cmd)
	cmd.Flags().StringVarP(&manifestPath, "from-file", "f", "", "Create from a local router.yml/router.yaml file or a directory containing one")
	return cmd
}

func createRouterFromManifest(cmd *cobra.Command, gf *globalFlags, path string) error {
	manifest, resolvedPath, err := loadRouterManifest(path)
	if err != nil {
		return err
	}
	body, err := manifest.createRequest(resolvedPath, func() (map[string]string, error) {
		return routerModelCatalogDefaults(cmd, gf)
	})
	if err != nil {
		return err
	}
	var resp map[string]any
	if err := orgKeyRequest(cmd, gf, http.MethodPost, "/v1/organizations/current/routers", body, &resp); err != nil {
		return err
	}
	return printJSON(resp)
}

func newRouterUpdateCmd(gf *globalFlags) *cobra.Command {
	rf := &routerConfigFlags{}
	var name string
	cmd := &cobra.Command{
		Use:   "update <router_id_or_endpoint>",
		Short: "Update a router; only the flags you pass change",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			routerID, err := normalizeRouterID(args[0])
			if err != nil {
				return err
			}
			var current routerCurrent
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/routers/"+url.PathEscape(routerID), nil, &current); err != nil {
				return err
			}
			body := routerUpdateRequest{
				Name:          current.Name,
				EnabledModels: current.EnabledModels,
			}
			if cmd.Flags().Changed("allow-long-context") {
				body.AllowLongContext = &rf.allowLongContext
			}
			if cmd.Flags().Changed("eval-score-imputation") {
				body.EvalScoreImputation = &rf.evalScoreImputation
			}
			if cmd.Flags().Changed("session-pinning") {
				body.SessionPinning = &rf.sessionPinning
			}
			if cmd.Flags().Changed("native-compaction") {
				body.NativeCompaction = &rf.nativeCompaction
			}
			if body.SubscriptionProviders, body.SubscriptionAPIFallbackModels, err = rf.subscriptionSettings(cmd); err != nil {
				return err
			}
			if cmd.Flags().Changed("name") {
				body.Name = strings.TrimSpace(name)
			}
			if cmd.Flags().Changed("model") {
				body.EnabledModels = rf.models
			}
			keys, err := rf.providerKeys(cmd.ErrOrStderr())
			if err != nil {
				return err
			}
			if len(keys) > 0 {
				body.ProviderKeys = keys
			}
			credentialIDs, err := rf.providerCredentialIDs()
			if err != nil {
				return err
			}
			if len(credentialIDs) > 0 {
				body.ProviderCredentialIDs = credentialIDs
			}
			sources := rf.providerKeySources()
			if err := validateProviderCredentialSelections(keys, credentialIDs, sources); err != nil {
				return err
			}
			if sources != nil {
				body.ProviderKeySources = sources
			}
			strategy, err := routerStrategyForUpdate(rf.strategy, current.RoutingStrategy)
			if err != nil {
				return err
			}
			if rf.strategy != "" {
				body.RoutingStrategy = strategy
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodPut, "/v1/organizations/current/routers/"+url.PathEscape(routerID), body, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	rf.register(cmd)
	cmd.Flags().StringVar(&name, "name", "", "Rename the router")
	return cmd
}

func validateProviderCredentialSelections(keys, credentialIDs, sources map[string]string) error {
	for provider := range credentialIDs {
		if strings.TrimSpace(keys[provider]) != "" {
			return fmt.Errorf("provider %s cannot use both --provider-credential and an inline provider key", provider)
		}
		if sources[provider] == "managed" {
			return fmt.Errorf("provider %s cannot use both --provider-credential and --managed-key", provider)
		}
	}
	return nil
}

func newRouterAssignAgentCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "assign-agent <router_id_or_endpoint> <agent>",
		Short: "Make a coding agent launched by dari use this router",
		Long: "Make a coding agent launched by dari use this router. Agents are " +
			strings.Join(codingAgentNames(), ", ") +
			". Assign an agent to the default router to undo; `dari router list` shows each router's coding_agents.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			routerID, err := normalizeRouterID(args[0])
			if err != nil {
				return err
			}
			setup, ok := agentSetups[args[1]]
			if !ok {
				return fmt.Errorf("unknown coding agent %q; use one of %s", args[1], strings.Join(codingAgentNames(), ", "))
			}
			path := "/v1/organizations/current/routers/" + url.PathEscape(routerID) + "/coding-agents/" + url.PathEscape(setup.codingAgent)
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodPut, path, nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

// codingAgentNames are the launcher names of the agents dari sets up.
func codingAgentNames() []string {
	names := make([]string, 0, len(agentSetups))
	for name := range agentSetups {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func newRouterDeleteCmd(gf *globalFlags) *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:   "delete <router_id_or_endpoint>",
		Short: "Soft-delete a router for the current org",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			routerID, err := normalizeRouterID(args[0])
			if err != nil {
				return err
			}
			if !yes && !confirm(fmt.Sprintf("Delete router %s? API keys pointing at it will stop routing. [y/N] ", routerID)) {
				return fmt.Errorf("aborted")
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodDelete, "/v1/organizations/current/routers/"+url.PathEscape(routerID), nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "Skip the interactive confirmation prompt")
	return cmd
}

func routerStrategyForCreate(strategy string) (string, error) {
	switch strategy {
	case "", "dari":
		return strategy, nil
	case "custom":
		return "", fmt.Errorf("custom routing requires a manifest with custom_config; use dari router create --from-file")
	default:
		return "", fmt.Errorf("--strategy must be dari")
	}
}

func routerStrategyForUpdate(strategy, currentStrategy string) (string, error) {
	if strategy == "" {
		return currentStrategy, nil
	}
	if strategy == "custom" && currentStrategy != "custom" {
		return "", fmt.Errorf("custom routing rules cannot be set with flags; create the router from a manifest with custom_config (--from-file)")
	}
	if strategy != "dari" && strategy != "custom" {
		return "", fmt.Errorf("--strategy must be dari")
	}
	return strategy, nil
}

func splitPair(pair, flagName, format string) (string, string, error) {
	key, value, ok := strings.Cut(pair, "=")
	key = strings.TrimSpace(key)
	if !ok || key == "" || value == "" {
		return "", "", fmt.Errorf("invalid %s %q: expected %s", flagName, pair, format)
	}
	return key, value, nil
}

func looksLikeRouterManifestPath(arg string) bool {
	trimmed := strings.TrimSpace(arg)
	ext := strings.ToLower(filepath.Ext(trimmed))
	return trimmed == "." ||
		trimmed == ".." ||
		ext == ".yml" ||
		ext == ".yaml" ||
		strings.Contains(trimmed, "/") ||
		strings.Contains(trimmed, string(filepath.Separator))
}

func resolveRouterManifestPath(rawPath string) (string, error) {
	path := strings.TrimSpace(rawPath)
	if path == "" {
		return "", fmt.Errorf("router manifest path is required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("router manifest %s: %w", path, err)
	}
	if !info.IsDir() {
		return path, nil
	}
	for _, name := range []string{"router.yml", "router.yaml"} {
		candidate := filepath.Join(path, name)
		if candidateInfo, err := os.Stat(candidate); err == nil && !candidateInfo.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("router manifest directory %s must contain router.yml or router.yaml", path)
}

func loadRouterManifest(rawPath string) (routerCreateManifest, string, error) {
	path, err := resolveRouterManifestPath(rawPath)
	if err != nil {
		return routerCreateManifest{}, "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return routerCreateManifest{}, "", fmt.Errorf("read router manifest %s: %w", path, err)
	}
	var manifest routerCreateManifest
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	// io.EOF means an empty manifest; let createRequest report the missing
	// fields instead of surfacing a bare "EOF".
	if err := decoder.Decode(&manifest); err != nil && !errors.Is(err, io.EOF) {
		return routerCreateManifest{}, "", fmt.Errorf("parse router manifest %s: %w", path, err)
	}
	return manifest, path, nil
}

// routerModelCatalogDefaults fetches each catalog model's default execution
// provider so manifests without model_providers validate against the same
// bindings the control plane will apply.
func routerModelCatalogDefaults(cmd *cobra.Command, gf *globalFlags) (map[string]string, error) {
	var resp struct {
		Groups []struct {
			Models []struct {
				ID              string `json:"id"`
				Provider        string `json:"provider"`
				DefaultProvider string `json:"default_provider"`
			} `json:"models"`
		} `json:"groups"`
	}
	if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/routers/model-catalog", nil, &resp); err != nil {
		return nil, err
	}
	defaults := map[string]string{}
	for _, group := range resp.Groups {
		for _, model := range group.Models {
			provider := strings.ToLower(strings.TrimSpace(model.DefaultProvider))
			if provider == "" {
				provider = strings.ToLower(strings.TrimSpace(model.Provider))
			}
			if model.ID == "" || provider == "" {
				continue
			}
			if _, exists := defaults[model.ID]; !exists || model.DefaultProvider != "" {
				defaults[model.ID] = provider
			}
		}
	}
	return defaults, nil
}

func (manifest routerCreateManifest) createRequest(path string, resolveCatalogDefaults func() (map[string]string, error)) (routerCreateRequest, error) {
	name := strings.TrimSpace(manifest.Name)
	if name == "" {
		return routerCreateRequest{}, fmt.Errorf("%s: name is required", path)
	}
	models, err := cleanRequiredStrings(manifest.EnabledModels, path, "enabled_models")
	if err != nil {
		return routerCreateRequest{}, err
	}
	if len(models) == 0 {
		return routerCreateRequest{}, fmt.Errorf("%s: enabled_models must contain at least one model", path)
	}
	modelProviders, err := cleanModelProviders(path, manifest.ModelProviders, models)
	if err != nil {
		return routerCreateRequest{}, err
	}
	providerKeys, err := manifestProviderKeys(path, manifest.ProviderKeys, manifest.ProviderKeyEnvs)
	if err != nil {
		return routerCreateRequest{}, err
	}
	providerKeySources, err := cleanProviderKeySources(path, manifest.ProviderKeySources)
	if err != nil {
		return routerCreateRequest{}, err
	}
	providerCredentialIDs, err := cleanProviderCredentialIDs(path, manifest.ProviderCredentialIDs, providerKeys, providerKeySources)
	if err != nil {
		return routerCreateRequest{}, err
	}
	validationKeys := make(map[string]string, len(providerKeys)+len(providerCredentialIDs))
	validationSources := make(map[string]string, len(providerKeySources)+len(providerCredentialIDs))
	for provider, source := range providerKeySources {
		validationSources[provider] = source
	}
	for provider, value := range providerKeys {
		validationKeys[provider] = value
	}
	for provider := range providerCredentialIDs {
		validationKeys[provider] = "saved-credential"
		if validationSources[provider] == "" {
			validationSources[provider] = "user"
		}
	}
	if err := validateManifestProviderKeys(path, validationSources, validationKeys, models, modelProviders, resolveCatalogDefaults); err != nil {
		return routerCreateRequest{}, err
	}
	modelThinkingLevels, err := normalizeManifestModelThinkingLevels(
		path,
		manifest.ModelThinkingLevels,
		models,
	)
	if err != nil {
		return routerCreateRequest{}, err
	}
	fastModels, err := normalizeManifestModelList(path, "fast_models", manifest.FastModels, models)
	if err != nil {
		return routerCreateRequest{}, err
	}
	subscriptionProviders, err := normalizeManifestSubscriptionProviders(path, manifest.SubscriptionProviders)
	if err != nil {
		return routerCreateRequest{}, err
	}
	apiFallbackModels, err := normalizeManifestModelList(path, "subscription_api_fallback_models", manifest.SubscriptionAPIFallbackModels, models)
	if err != nil {
		return routerCreateRequest{}, err
	}
	strategy, err := routerStrategyForManifest(
		path,
		strings.ToLower(strings.TrimSpace(manifest.RoutingStrategy)),
		manifest.CustomConfig != nil,
	)
	if err != nil {
		return routerCreateRequest{}, err
	}
	customConfig, err := normalizeManifestCustomConfig(
		path,
		manifest.CustomConfig,
		models,
		modelThinkingLevels,
	)
	if err != nil {
		return routerCreateRequest{}, err
	}
	body := routerCreateRequest{
		Name:                name,
		AllowLongContext:    manifest.AllowLongContext,
		EvalScoreImputation: manifest.EvalScoreImputation,
		SessionPinning:      manifest.SessionPinning,
		NativeCompaction:    manifest.NativeCompaction,
		EnabledModels:       models,
		ModelProviders:      modelProviders,
	}
	if len(providerKeys) > 0 {
		body.ProviderKeys = providerKeys
	}
	if len(providerCredentialIDs) > 0 {
		body.ProviderCredentialIDs = providerCredentialIDs
	}
	if len(providerKeySources) > 0 {
		body.ProviderKeySources = providerKeySources
	}
	if strategy != "" {
		body.RoutingStrategy = strategy
	}
	body.CustomConfig = customConfig
	body.ModelThinkingLevels = modelThinkingLevels
	body.FastModels = fastModels
	body.SubscriptionProviders = subscriptionProviders
	body.SubscriptionAPIFallbackModels = apiFallbackModels
	return body, nil
}

func cleanProviderCredentialIDs(path string, rawIDs, providerKeys, sources map[string]string) (map[string]string, error) {
	ids := map[string]string{}
	for rawProvider, rawID := range rawIDs {
		provider := strings.ToLower(strings.TrimSpace(rawProvider))
		credentialID := strings.TrimSpace(rawID)
		if provider == "" || credentialID == "" {
			return nil, fmt.Errorf("%s: provider_credential_ids entries must be provider: credential_id", path)
		}
		if _, exists := ids[provider]; exists {
			return nil, fmt.Errorf("%s: provider_credential_ids defines provider %s more than once", path, provider)
		}
		if strings.TrimSpace(providerKeys[provider]) != "" {
			return nil, fmt.Errorf("%s: provider %s cannot use both provider_credential_ids and inline provider keys", path, provider)
		}
		if sources[provider] == "managed" {
			return nil, fmt.Errorf("%s: provider_credential_ids can only include providers marked as user; %s is managed", path, provider)
		}
		ids[provider] = credentialID
	}
	return ids, nil
}

func cleanRequiredStrings(values []string, path, field string) ([]string, error) {
	cleaned := make([]string, 0, len(values))
	for index, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return nil, fmt.Errorf("%s: %s[%d] must be non-empty", path, field, index)
		}
		cleaned = append(cleaned, trimmed)
	}
	return cleaned, nil
}

// The API matches provider names case-insensitively, so manifest provider
// names are normalized to lowercase before validation and submission.
func manifestProviderKeys(path string, rawKeys, rawEnvs map[string]string) (map[string]string, error) {
	keys := map[string]string{}
	for rawProvider, rawValue := range rawKeys {
		provider := strings.ToLower(strings.TrimSpace(rawProvider))
		value := strings.TrimSpace(rawValue)
		if provider == "" || value == "" {
			return nil, fmt.Errorf("%s: provider_keys entries must be provider: key", path)
		}
		if _, exists := keys[provider]; exists {
			return nil, fmt.Errorf("%s: provider_keys defines provider %s more than once", path, provider)
		}
		keys[provider] = value
	}
	for rawProvider, rawEnv := range rawEnvs {
		provider := strings.ToLower(strings.TrimSpace(rawProvider))
		envName := strings.TrimSpace(rawEnv)
		if provider == "" || envName == "" {
			return nil, fmt.Errorf("%s: provider_key_envs entries must be provider: ENV_VAR", path)
		}
		if _, exists := keys[provider]; exists {
			return nil, fmt.Errorf("%s: provider %s is defined more than once across provider_keys and provider_key_envs", path, provider)
		}
		value := os.Getenv(envName)
		if strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("%s: provider_key_envs.%s references unset or empty environment variable %s", path, provider, envName)
		}
		keys[provider] = value
	}
	return keys, nil
}

func cleanProviderKeySources(path string, rawSources map[string]string) (map[string]string, error) {
	sources := map[string]string{}
	for rawProvider, rawSource := range rawSources {
		provider := strings.ToLower(strings.TrimSpace(rawProvider))
		source := strings.TrimSpace(rawSource)
		if provider == "" {
			return nil, fmt.Errorf("%s: provider_key_sources has an empty provider name", path)
		}
		source = strings.ToLower(source)
		if source != "managed" && source != "user" {
			return nil, fmt.Errorf("%s: provider_key_sources.%s must be managed or user", path, provider)
		}
		if _, exists := sources[provider]; exists {
			return nil, fmt.Errorf("%s: provider_key_sources defines provider %s more than once", path, provider)
		}
		sources[provider] = source
	}
	return sources, nil
}

func cleanModelProviders(path string, raw map[string]string, models []string) (map[string]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	enabled := map[string]bool{}
	for _, model := range models {
		enabled[model] = true
	}
	cleaned := map[string]string{}
	for rawModel, rawProvider := range raw {
		model := strings.TrimSpace(rawModel)
		provider := strings.ToLower(strings.TrimSpace(rawProvider))
		if !enabled[model] {
			return nil, fmt.Errorf("%s: model_providers.%s is not in enabled_models", path, model)
		}
		if provider == "" {
			return nil, fmt.Errorf("%s: model_providers.%s must be non-empty", path, model)
		}
		if _, exists := cleaned[model]; exists {
			return nil, fmt.Errorf("%s: model_providers defines model %s more than once", path, model)
		}
		cleaned[model] = provider
	}
	if len(cleaned) != len(enabled) {
		return nil, fmt.Errorf("%s: model_providers must contain every enabled_models entry", path)
	}
	return cleaned, nil
}

// validateManifestProviderKeys validates provider key declarations against the
// providers the enabled models resolve to. Without explicit model_providers it
// first assumes each model's namespace serves it; only when that fails does it
// consult the catalog defaults (a network call on the create path), because
// owner-namespace models (deepseek-ai/…) do not name their serving provider.
func validateManifestProviderKeys(path string, sources, keys map[string]string, models []string, modelProviders map[string]string, resolveCatalogDefaults func() (map[string]string, error)) error {
	err := validateManifestProviderKeysWith(path, sources, keys, models, modelProviders, nil)
	if err == nil || len(modelProviders) > 0 || resolveCatalogDefaults == nil {
		return err
	}
	catalogDefaults, fetchErr := resolveCatalogDefaults()
	if fetchErr != nil {
		return errors.Join(err, fmt.Errorf("resolving default providers from the model catalog also failed (declare model_providers in %s): %w", path, fetchErr))
	}
	if len(catalogDefaults) == 0 {
		return err
	}
	return validateManifestProviderKeysWith(path, sources, keys, models, modelProviders, catalogDefaults)
}

func validateManifestProviderKeysWith(path string, sources, keys map[string]string, models []string, modelProviders map[string]string, catalogDefaults map[string]string) error {
	// Always resolves, even when model_providers overrides the result below:
	// it also rejects enabled_models entries without a provider-prefixed shape.
	providers, err := providersForRouterModels(path, models, catalogDefaults)
	if err != nil {
		return err
	}
	if len(modelProviders) > 0 {
		// cleanModelProviders guarantees a non-empty provider per enabled model.
		providers = make([]string, 0, len(models))
		for _, model := range models {
			providers = append(providers, modelProviders[model])
		}
	}
	expected := map[string]bool{}
	for _, provider := range providers {
		expected[provider] = true
	}
	for provider := range sources {
		if !expected[provider] {
			return fmt.Errorf("%s: provider_key_sources.%s does not match any enabled_models provider", path, provider)
		}
	}
	for provider := range keys {
		if !expected[provider] {
			return fmt.Errorf("%s: provider key for %s does not match any enabled_models provider", path, provider)
		}
	}
	for provider, source := range sources {
		if source == "managed" && strings.TrimSpace(keys[provider]) != "" {
			return fmt.Errorf("%s: provider_keys can only include providers marked as user; %s is managed", path, provider)
		}
	}
	for _, provider := range providers {
		if !manifestProviderUsesManifestCredentials(provider) {
			if strings.TrimSpace(keys[provider]) != "" {
				return fmt.Errorf("%s: provider key for %s is configured by the custom model credential", path, provider)
			}
			if sources[provider] == "managed" {
				return fmt.Errorf("%s: provider_key_sources.%s cannot be managed for a custom model provider", path, provider)
			}
			continue
		}
		switch sources[provider] {
		case "":
			return fmt.Errorf("%s: provider_key_sources.%s is required; set it to managed or user", path, provider)
		case "user":
			if strings.TrimSpace(keys[provider]) == "" {
				return fmt.Errorf("%s: provider_key_sources.%s is user, so provider_keys.%s or provider_key_envs.%s is required", path, provider, provider, provider)
			}
		}
	}
	return nil
}

// Structural manifest validation stays offline; only default-provider
// resolution may consult the model catalog. Built-in router providers need
// manifest-managed key selection, while org custom model providers resolve their
// credentials from the model catalog and may omit manifest provider key fields.
func manifestProviderUsesManifestCredentials(provider string) bool {
	switch provider {
	case "amazon-bedrock", "anthropic", "azure", "baseten", "fireworks", "openai", "openrouter", "vercel-ai-gateway", "xai":
		return true
	default:
		return false
	}
}

// providersForRouterModels resolves each model's execution provider when the
// manifest declares no model_providers. Catalog defaults win because canonical
// model ids carry the owner's namespace (deepseek-ai/…), which is not
// necessarily the serving provider; the namespace covers models the catalog
// does not know (org custom models).
func providersForRouterModels(path string, models []string, catalogDefaults map[string]string) ([]string, error) {
	seen := map[string]bool{}
	providers := []string{}
	for _, model := range models {
		namespace, _, ok := strings.Cut(model, "/")
		namespace = strings.ToLower(namespace)
		if !ok || namespace == "" {
			return nil, fmt.Errorf("%s: enabled_models entry %s must be a provider-prefixed model ID like openai/gpt-5.5", path, model)
		}
		provider := namespace
		if fromCatalog := catalogDefaults[model]; fromCatalog != "" {
			provider = fromCatalog
		}
		if seen[provider] {
			continue
		}
		seen[provider] = true
		providers = append(providers, provider)
	}
	return providers, nil
}

const (
	manifestCustomRulesMaxCount     = 20
	manifestCustomRuleWhenMaxLength = 500
)

var routerThinkingLevels = []string{
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
}

func normalizeManifestModelThinkingLevels(
	path string,
	raw map[string][]string,
	models []string,
) (map[string][]string, error) {
	if raw == nil {
		return nil, nil
	}
	enabled := make(map[string]bool, len(models))
	for _, model := range models {
		enabled[model] = true
	}
	for model := range raw {
		if !enabled[model] {
			return nil, fmt.Errorf("%s: model_thinking_levels.%s is not in enabled_models", path, model)
		}
	}

	normalized := make(map[string][]string, len(models))
	for _, model := range models {
		rawLevels, ok := raw[model]
		if !ok {
			return nil, fmt.Errorf("%s: model_thinking_levels must contain every enabled_models entry", path)
		}
		if len(rawLevels) == 0 {
			return nil, fmt.Errorf("%s: model_thinking_levels.%s must contain at least one level", path, model)
		}
		selected := make(map[string]bool, len(rawLevels))
		for index, rawLevel := range rawLevels {
			level := strings.ToLower(strings.TrimSpace(rawLevel))
			if !slices.Contains(routerThinkingLevels, level) {
				return nil, fmt.Errorf(
					"%s: model_thinking_levels.%s[%d] must be one of: %s",
					path,
					model,
					index,
					strings.Join(routerThinkingLevels, ", "),
				)
			}
			selected[level] = true
		}
		levels := make([]string, 0, len(selected))
		for _, level := range routerThinkingLevels {
			if selected[level] {
				levels = append(levels, level)
			}
		}
		normalized[model] = levels
	}
	return normalized, nil
}

// normalizeManifestModelList checks that every entry of a model list field is
// an enabled model and returns them in enabled_models order.
func normalizeManifestModelList(path, field string, raw, models []string) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	enabled := make(map[string]bool, len(models))
	for _, model := range models {
		enabled[model] = true
	}
	selected := make(map[string]bool, len(raw))
	for index, rawModel := range raw {
		model := strings.TrimSpace(rawModel)
		if model == "" {
			return nil, fmt.Errorf("%s: %s[%d] must be non-empty", path, field, index)
		}
		if !enabled[model] {
			return nil, fmt.Errorf("%s: %s[%d] must be one of enabled_models", path, field, index)
		}
		selected[model] = true
	}
	normalized := make([]string, 0, len(selected))
	for _, model := range models {
		if selected[model] {
			normalized = append(normalized, model)
		}
	}
	return normalized, nil
}

func normalizeManifestSubscriptionProviders(path string, raw []string) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	providers := make([]string, 0, len(raw))
	for index, rawProvider := range raw {
		provider := strings.ToLower(strings.TrimSpace(rawProvider))
		if !isSubscriptionRouterProvider(provider) {
			return nil, fmt.Errorf("%s: subscription_providers[%d] must be openai, anthropic, or meta", path, index)
		}
		if !slices.Contains(providers, provider) {
			providers = append(providers, provider)
		}
	}
	return providers, nil
}

func normalizeManifestCustomConfig(
	path string,
	config *routerCustomConfig,
	models []string,
	modelThinkingLevels map[string][]string,
) (*routerCustomConfig, error) {
	if config == nil {
		return nil, nil
	}
	if len(config.Rules) == 0 {
		return nil, fmt.Errorf("%s: custom_config.rules must contain at least one rule", path)
	}
	if len(config.Rules) > manifestCustomRulesMaxCount {
		return nil, fmt.Errorf("%s: custom_config.rules supports at most %d rules", path, manifestCustomRulesMaxCount)
	}
	enabled := map[string]bool{}
	for _, model := range models {
		enabled[model] = true
	}
	rules := make([]routerCustomRule, 0, len(config.Rules))
	for index, rule := range config.Rules {
		when := strings.TrimSpace(rule.When)
		if when == "" {
			return nil, fmt.Errorf("%s: custom_config.rules[%d].when must be non-empty", path, index)
		}
		if len([]rune(when)) > manifestCustomRuleWhenMaxLength {
			return nil, fmt.Errorf("%s: custom_config.rules[%d].when must be at most %d characters", path, index, manifestCustomRuleWhenMaxLength)
		}
		use := strings.TrimSpace(rule.Use)
		if use == "" {
			return nil, fmt.Errorf("%s: custom_config.rules[%d].use must be non-empty", path, index)
		}
		if !enabled[use] {
			return nil, fmt.Errorf("%s: custom_config.rules[%d].use must be one of enabled_models", path, index)
		}
		thinkingLevel, err := normalizeManifestTargetThinkingLevel(
			fmt.Sprintf("%s: custom_config.rules[%d].thinking_level", path, index),
			use,
			rule.ThinkingLevel,
			modelThinkingLevels,
		)
		if err != nil {
			return nil, err
		}
		rules = append(rules, routerCustomRule{
			When:          when,
			Use:           use,
			ThinkingLevel: thinkingLevel,
		})
	}
	var defaultModel *string
	var defaultThinkingLevel *string
	if config.Default != nil {
		value := strings.TrimSpace(*config.Default)
		if value == "" {
			return nil, fmt.Errorf("%s: custom_config.default must be non-empty when set", path)
		}
		if !enabled[value] {
			return nil, fmt.Errorf("%s: custom_config.default must be one of enabled_models", path)
		}
		defaultModel = &value
		normalizedDefaultThinkingLevel, err := normalizeManifestTargetThinkingLevel(
			path+": custom_config.default_thinking_level",
			value,
			config.DefaultThinkingLevel,
			modelThinkingLevels,
		)
		if err != nil {
			return nil, err
		}
		defaultThinkingLevel = normalizedDefaultThinkingLevel
	} else if config.DefaultThinkingLevel != nil {
		return nil, fmt.Errorf("%s: custom_config.default is required when default_thinking_level is set", path)
	}
	return &routerCustomConfig{
		Rules:                rules,
		Default:              defaultModel,
		DefaultThinkingLevel: defaultThinkingLevel,
	}, nil
}

func normalizeManifestTargetThinkingLevel(
	label string,
	model string,
	raw *string,
	modelThinkingLevels map[string][]string,
) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	level := strings.ToLower(strings.TrimSpace(*raw))
	if !slices.Contains(routerThinkingLevels, level) {
		return nil, fmt.Errorf(
			"%s must be null or one of: %s",
			label,
			strings.Join(routerThinkingLevels, ", "),
		)
	}
	if enabledLevels := modelThinkingLevels[model]; enabledLevels != nil && !slices.Contains(enabledLevels, level) {
		return nil, fmt.Errorf("%s must be enabled in model_thinking_levels.%s", label, model)
	}
	return &level, nil
}

func routerStrategyForManifest(path, strategy string, hasCustomConfig bool) (string, error) {
	switch {
	case strategy == "custom" && !hasCustomConfig:
		return "", fmt.Errorf("%s: routing_strategy custom requires custom_config", path)
	case strategy == "dari" && hasCustomConfig:
		return "", fmt.Errorf("%s: custom_config is only supported when routing_strategy is custom", path)
	case strategy == "custom" || strategy == "dari":
		return strategy, nil
	case strategy != "":
		return "", fmt.Errorf("%s: routing_strategy must be dari or custom", path)
	case hasCustomConfig:
		return "custom", nil
	default:
		return "", nil
	}
}

// isSubscriptionRouterProvider reports whether a personal subscription can
// serve the router provider's models.
func isSubscriptionRouterProvider(provider string) bool {
	return slices.ContainsFunc(
		[]agentSubscriptionProvider{codexSubscription, claudeSubscription, museSubscription},
		func(subscription agentSubscriptionProvider) bool { return subscription.routerProvider == provider },
	)
}
