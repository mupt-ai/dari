package cli

import (
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		cmd := &cobra.Command{
			Use:     "router",
			Aliases: []string{"routers"},
			Short:   "Manage routers: your hosted org's, or on a local or self-hosted gateway, a router spec file each",
		}
		cmd.PersistentFlags().Bool("hosted", false, "Act on your hosted Dari org even while agents route through a gateway")
		cmd.AddCommand(
			newRouterListCmd(gf),
			newRouterGetCmd(gf),
			newRouterModelsCmd(gf),
			newRouterRequestCostsCmd(),
			newRouterApplyCmd(gf),
			newRouterCreateCmd(gf),
			newRouterUpdateCmd(gf),
			newRouterAssignAgentCmd(gf),
			newRouterExperimentsCmd(gf),
			newRouterPublishCmd(gf),
			newRouterUnpublishCmd(gf),
			newRouterDeleteCmd(gf),
			newRouterPullCmd(gf),
		)
		root.AddCommand(cmd)
	})
}

func newRouterListCmd(gf *globalFlags) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List routers for the current org, or on the gateway",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if gw, err := routerGateway(cmd); err != nil || gw != nil {
				if err != nil {
					return err
				}
				return listGatewayRouters(cmd, gw)
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/routers", nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
}

func newRouterGetCmd(gf *globalFlags) *cobra.Command {
	var asYAML bool
	cmd := &cobra.Command{
		Use:   "get <router_id_or_endpoint>",
		Short: "Show one router for the current org; --yaml prints it as a router spec",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if gw, err := routerGateway(cmd); err != nil || gw != nil {
				if err != nil {
					return err
				}
				return getGatewayRouter(cmd, gw, args[0])
			}
			routerID, err := normalizeRouterID(args[0])
			if err != nil {
				return err
			}
			if asYAML {
				return getRouterSpec(cmd, gf, routerID)
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/routers/"+url.PathEscape(routerID), nil, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	cmd.Flags().BoolVar(&asYAML, "yaml", false, "Print the router as a spec `dari router apply` takes: everything but credentials")
	return cmd
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

// routerRoles holds one value for the main agent and one for subagents: a
// fixed model (role_models) or a system prompt addition (role_prompts). A nil
// role has none.
type routerRoles struct {
	Main     *string `json:"main"`
	Subagent *string `json:"subagent"`
}

type routerCreateRequest struct {
	AllowLongContext      bool              `json:"allow_long_context,omitempty"`
	EvalScoreImputation   *bool             `json:"eval_score_imputation,omitempty"`
	SessionPinning        bool              `json:"session_pinning,omitempty"`
	NativeCompaction      bool              `json:"native_compaction,omitempty"`
	Name                  string            `json:"name"`
	EnabledModels         []string          `json:"enabled_models"`
	ProviderKeys          map[string]string `json:"provider_keys,omitempty"`
	ProviderCredentialIDs map[string]string `json:"provider_credential_ids,omitempty"`
	RoutingStrategy       string            `json:"routing_strategy"`
	RoleModels            *routerRoles      `json:"role_models,omitempty"`
	RolePrompts           *routerRoles      `json:"role_prompts,omitempty"`
	// Where each model is served from, in order: "plan" (the attributed
	// user's subscriptions), "reset" (a banked reset), "key" (the router's
	// saved key for the provider), "managed" (Dari's key, billed to credits).
	ModelSources map[string][]string `json:"model_sources,omitempty"`
	// Spend a banked reset only when a plan would be out this many hours.
	ResetMinHours *int `json:"reset_min_hours,omitempty"`
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
	// Omitted keeps the current role models; an object replaces both roles.
	RoleModels  *routerRoles `json:"role_models,omitempty"`
	RolePrompts *routerRoles `json:"role_prompts,omitempty"`
	// Omitted keeps each model's sources; a listed model gets the given list.
	ModelSources  map[string][]string `json:"model_sources,omitempty"`
	ResetMinHours *int                `json:"reset_min_hours,omitempty"`
}

type routerCurrent struct {
	Name          string      `json:"name"`
	EnabledModels []string    `json:"enabled_models"`
	RoleModels    routerRoles `json:"role_models"`
	RolePrompts   routerRoles `json:"role_prompts"`
}

type routerConfigFlags struct {
	allowLongContext    bool
	evalScoreImputation bool
	sessionPinning      bool
	nativeCompaction    bool
	models              []string
	modelSources        []string
	resetMinHours       int
	providerKeyPairs    []string
	providerKeyEnvs     []string
	providerCredentials []string
	managedKeyProvider  []string
	mainModel           string
	subagentModel       string
	mainPrompt          string
	subagentPrompt      string
	flagNames           []string
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
	cmd.Flags().StringSliceVar(&rf.managedKeyProvider, name("managed-key"), nil, "Serve this provider's models from Dari's managed key, billed to credits; ignored with --sources (repeatable or comma-separated)")
	cmd.Flags().StringVar(&rf.mainModel, name("main-model"), "", "Serve the main agent this enabled model instead of routing it; on update an empty value routes it again")
	cmd.Flags().StringVar(&rf.subagentModel, name("subagent-model"), "", "Serve subagents this enabled model instead of routing them; on update an empty value routes them again")
	cmd.Flags().StringVar(&rf.mainPrompt, name("main-prompt"), "", "Append this text to the main agent's system prompt, e.g. to nudge it to delegate; on update an empty value removes it")
	cmd.Flags().StringVar(&rf.subagentPrompt, name("subagent-prompt"), "", "Append this text to subagents' system prompt; on update an empty value removes it")
	cmd.Flags().BoolVar(&rf.allowLongContext, name("allow-long-context"), false, "Allow provider long-context surcharges (off by default)")
	cmd.Flags().BoolVar(&rf.evalScoreImputation, name("eval-score-imputation"), true, "Estimate missing eval scores for a model and thinking level from related measured scores (on by default)")
	cmd.Flags().BoolVar(&rf.sessionPinning, name("session-pinning"), false, "Route once when a session starts and keep that model for the whole session; each subagent is routed once when it starts (off by default)")
	cmd.Flags().BoolVar(&rf.nativeCompaction, name("native-compaction"), false, "Let Codex compact context server-side with the provider's native compaction; requests carrying compaction state are routed only to models that support it (off by default)")
	cmd.Flags().StringArrayVar(&rf.modelSources, name("sources"), nil, "Where a model is served from, in order, as MODEL=plan,reset,key,managed: plan is the attributed user's subscriptions, reset spends a banked reset when they are out (right after plan), key the router's saved key for the provider, managed Dari's key billed to credits; an empty list serves it from none (repeatable)")
	cmd.Flags().IntVar(&rf.resetMinHours, name("reset-min-hours"), 24, "Spend a banked reset only when the plan would otherwise be out at least this many hours, or the reset would expire first (default 24)")
}

// sources parses --sources, nil when it was not passed.
func (rf *routerConfigFlags) sources(cmd *cobra.Command) (map[string][]string, error) {
	if !cmd.Flags().Changed("sources") {
		return nil, nil
	}
	return parseModelSources(rf.modelSources)
}

// resetMinHours is --reset-min-hours, nil when it was not passed.
func (rf *routerConfigFlags) resetHours(cmd *cobra.Command) (*int, error) {
	if !cmd.Flags().Changed("reset-min-hours") {
		return nil, nil
	}
	if rf.resetMinHours < 0 {
		return nil, fmt.Errorf("--reset-min-hours must be 0 or more")
	}
	return &rf.resetMinHours, nil
}

// keyedModelSources is the sources the key flags imply: models of a provider
// given a saved or inline key get ["key"], of one given --managed-key
// ["managed"], and, when withPlan, the rest ["plan"]; otherwise the rest are
// left out so they keep their sources.
func keyedModelSources(cmd *cobra.Command, gf *globalFlags, models, keyed, managed []string, withPlan bool) (map[string][]string, error) {
	var catalog agentModelCatalog
	if err := orgKeyRequest(cmd, gf, http.MethodGet, "/v1/organizations/current/routers/model-catalog", nil, &catalog); err != nil {
		return nil, err
	}
	providers := map[string]string{}
	for _, group := range catalog.Groups {
		for _, model := range group.Models {
			if _, seen := providers[model.ID]; !seen || model.DefaultProvider == group.Provider {
				providers[model.ID] = group.Provider
			}
		}
	}
	out := map[string][]string{}
	for _, model := range models {
		provider, listed := providers[model]
		if !listed {
			// A model the catalog doesn't list is named by its provider.
			provider, _, _ = strings.Cut(model, "/")
		}
		var sources []string
		if slices.Contains(keyed, provider) {
			sources = append(sources, "key")
		}
		if slices.Contains(managed, provider) {
			sources = append(sources, "managed")
		}
		if sources == nil && withPlan {
			sources = []string{"plan"}
		}
		if sources != nil {
			out[model] = sources
		}
	}
	return out, nil
}

// parseModelSources reads MODEL=plan,reset,key,managed pairs.
func parseModelSources(pairs []string) (map[string][]string, error) {
	out := map[string][]string{}
	for _, pair := range pairs {
		model, list, ok := strings.Cut(pair, "=")
		model = strings.TrimSpace(model)
		if !ok || model == "" {
			return nil, fmt.Errorf("--sources %q must be MODEL=plan,reset,key,managed", pair)
		}
		if _, dup := out[model]; dup {
			return nil, fmt.Errorf("--sources names model %s more than once", model)
		}
		sources := []string{}
		for _, source := range strings.Split(list, ",") {
			source = strings.ToLower(strings.TrimSpace(source))
			if source == "" {
				continue
			}
			if !slices.Contains([]string{"plan", "reset", "key", "managed"}, source) {
				return nil, fmt.Errorf("--sources for %s: unknown source %q; use plan, reset, key, or managed", model, source)
			}
			if slices.Contains(sources, source) {
				return nil, fmt.Errorf("--sources for %s: source %s is listed twice", model, source)
			}
			sources = append(sources, source)
		}
		if i := slices.Index(sources, "reset"); i != -1 && (i == 0 || sources[i-1] != "plan") {
			return nil, fmt.Errorf("--sources for %s: source reset must come right after plan", model)
		}
		out[model] = sources
	}
	return out, nil
}

// roleModels and rolePrompts apply the role flags passed over current, or
// return nil when neither of the pair was passed.
func (rf *routerConfigFlags) roleModels(cmd *cobra.Command, current routerRoles) *routerRoles {
	return roleFlags(cmd, "main-model", rf.mainModel, "subagent-model", rf.subagentModel, current)
}

func (rf *routerConfigFlags) rolePrompts(cmd *cobra.Command, current routerRoles) *routerRoles {
	return roleFlags(cmd, "main-prompt", rf.mainPrompt, "subagent-prompt", rf.subagentPrompt, current)
}

func roleFlags(cmd *cobra.Command, mainFlag, mainValue, subagentFlag, subagentValue string, current routerRoles) *routerRoles {
	if !cmd.Flags().Changed(mainFlag) && !cmd.Flags().Changed(subagentFlag) {
		return nil
	}
	value := func(flagName, value string, currentValue *string) *string {
		if !cmd.Flags().Changed(flagName) {
			return currentValue
		}
		if value = strings.TrimSpace(value); value != "" {
			return &value
		}
		return nil
	}
	return &routerRoles{
		Main:     value(mainFlag, mainValue, current.Main),
		Subagent: value(subagentFlag, subagentValue, current.Subagent),
	}
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

// managedProviders are the providers named by --managed-key.
func (rf *routerConfigFlags) managedProviders() []string {
	var providers []string
	for _, provider := range rf.managedKeyProvider {
		if provider = strings.ToLower(strings.TrimSpace(provider)); provider != "" {
			providers = append(providers, provider)
		}
	}
	return providers
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
	cmd := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a router for the current org from flags; use 'dari router apply <file>' for a spec file",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(rf.models) == 0 {
				return fmt.Errorf("at least one --model is required; run 'dari router models' for the catalog")
			}
			body := routerCreateRequest{
				AllowLongContext: rf.allowLongContext,
				SessionPinning:   rf.sessionPinning,
				NativeCompaction: rf.nativeCompaction,
				Name:             strings.TrimSpace(args[0]),
				EnabledModels:    rf.models,
				RoutingStrategy:  "dari",
				RoleModels:       rf.roleModels(cmd, routerRoles{}),
				RolePrompts:      rf.rolePrompts(cmd, routerRoles{}),
			}
			// Omitted unless passed so the API default (on) applies.
			if cmd.Flags().Changed("eval-score-imputation") {
				body.EvalScoreImputation = &rf.evalScoreImputation
			}
			modelSources, err := rf.sources(cmd)
			if err != nil {
				return err
			}
			body.ModelSources = modelSources
			if body.ResetMinHours, err = rf.resetHours(cmd); err != nil {
				return err
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
			if err := validateProviderCredentialSelections(keys, credentialIDs); err != nil {
				return err
			}
			managed := rf.managedProviders()
			if body.ModelSources == nil && (len(keys) > 0 || len(credentialIDs) > 0 || len(managed) > 0) {
				keyed := slices.Concat(slices.Collect(maps.Keys(keys)), slices.Collect(maps.Keys(credentialIDs)))
				if body.ModelSources, err = keyedModelSources(cmd, gf, rf.models, keyed, managed, true); err != nil {
					return err
				}
			}
			var resp map[string]any
			if err := orgKeyRequest(cmd, gf, http.MethodPost, "/v1/organizations/current/routers", body, &resp); err != nil {
				return err
			}
			return printJSON(resp)
		},
	}
	rf.register(cmd)
	return cmd
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
			if body.ModelSources, err = rf.sources(cmd); err != nil {
				return err
			}
			if body.ResetMinHours, err = rf.resetHours(cmd); err != nil {
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
			if err := validateProviderCredentialSelections(keys, credentialIDs); err != nil {
				return err
			}
			// --managed-key without --sources moves that provider's models
			// onto Dari's managed key.
			if managed := rf.managedProviders(); body.ModelSources == nil && len(managed) > 0 {
				if body.ModelSources, err = keyedModelSources(cmd, gf, body.EnabledModels, nil, managed, false); err != nil {
					return err
				}
			}
			body.RoleModels = rf.roleModels(cmd, current.RoleModels)
			body.RolePrompts = rf.rolePrompts(cmd, current.RolePrompts)
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

func validateProviderCredentialSelections(keys, credentialIDs map[string]string) error {
	for provider := range credentialIDs {
		if strings.TrimSpace(keys[provider]) != "" {
			return fmt.Errorf("provider %s cannot use both --provider-credential and an inline provider key", provider)
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
			if gw, err := routerGateway(cmd); err != nil || gw != nil {
				if err != nil {
					return err
				}
				return deleteGatewayRouter(cmd, gw, args[0])
			}
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
