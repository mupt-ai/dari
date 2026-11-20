package cli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/auth"
)

func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, gf *globalFlags) {
		activity := &cobra.Command{Use: "activity", Short: "Read routing activity for the current org or gateway"}
		activity.AddCommand(
			newActivityFiltersCmd(gf),
			newActivityOverviewCmd(gf),
			newActivityModelsCmd(gf),
			newActivityPeopleCmd(gf),
			newActivityConversationsCmd(gf),
			newActivityRequestCmd(gf),
			newActivityCapabilitiesCmd(gf, "tools"),
			newActivityCapabilitiesCmd(gf, "skills"),
			newActivityPullRequestsCmd(gf),
		)
		root.AddCommand(activity)
	})
}

type activityFlags struct {
	from           string
	to             string
	routerID       string
	apiKeyIDs      []string
	userIDs        []string
	models         []string
	provider       string
	status         string
	keySource      string
	sourceScope    string
	organizationID string
	bucketSeconds  int
}

// activityModelsFlags preserves the model-query helper used by callers and tests.
type activityModelsFlags activityFlags

func (flags activityModelsFlags) query() (url.Values, error) {
	return activityFlags(flags).query(false)
}

func (flags *activityFlags) add(cmd *cobra.Command, bucket bool) {
	f := cmd.Flags()
	f.StringVar(&flags.from, "from", "", "Range start in RFC3339 format (inclusive)")
	f.StringVar(&flags.to, "to", "", "Range end in RFC3339 format (exclusive)")
	f.StringVar(&flags.routerID, "router-id", "", "Limit results to one router ID")
	f.StringArrayVar(&flags.apiKeyIDs, "api-key-id", nil, "Limit results to an API key ID (repeatable)")
	f.StringArrayVar(&flags.userIDs, "user-id", nil, "Limit results to an attributed user ID (repeatable)")
	f.StringArrayVar(&flags.models, "model", nil, "Limit results to a model ID (repeatable)")
	f.StringVar(&flags.provider, "provider", "", "Limit results to one provider")
	f.StringVar(&flags.status, "status", "", "Limit results by status: completed, provider_error, selector_error, or aborted")
	f.StringVar(&flags.keySource, "key-source", "", "Limit results by provider key source: managed, byok, or subscription")
	f.StringVar(&flags.sourceScope, "source-scope", "", "Limit source protocols with a comma-separated list, all, or none")
	f.StringVar(&flags.organizationID, "organization-id", "", "Read an explicit organization using browser login")
	if bucket {
		f.IntVar(&flags.bucketSeconds, "bucket-seconds", 0, "Time-series bucket size in seconds: 60, 300, 900, 1800, 86400, 604800, or 2592000 (default: chosen from the range)")
	}
	_ = cmd.MarkFlagRequired("from")
	_ = cmd.MarkFlagRequired("to")
}

func (flags activityFlags) query(bucket bool) (url.Values, error) {
	from, err := parseActivityTime("from", flags.from)
	if err != nil {
		return nil, err
	}
	to, err := parseActivityTime("to", flags.to)
	if err != nil {
		return nil, err
	}
	if !to.After(from) {
		return nil, fmt.Errorf("--to must be later than --from")
	}
	if to.Sub(from) > 366*24*time.Hour {
		return nil, fmt.Errorf("activity range cannot exceed 366 days")
	}
	status := strings.TrimSpace(flags.status)
	if status != "" && !validActivityStatus(status) {
		return nil, fmt.Errorf("invalid --status %q: expected completed, provider_error, selector_error, or aborted", status)
	}
	keySource := strings.TrimSpace(flags.keySource)
	if keySource == "byok" {
		keySource = "user"
	}
	if keySource != "" && keySource != "managed" && keySource != "user" && keySource != "subscription" {
		return nil, fmt.Errorf("invalid --key-source %q: expected managed, byok, or subscription", flags.keySource)
	}
	query := url.Values{}
	query.Set("from", from.Format(time.RFC3339Nano))
	query.Set("to", to.Format(time.RFC3339Nano))
	setOptionalQuery(query, "router_id", flags.routerID)
	setRepeatedQuery(query, "api_key_id", flags.apiKeyIDs)
	setRepeatedQuery(query, "user_id", flags.userIDs)
	setRepeatedQuery(query, "model", flags.models)
	setOptionalQuery(query, "provider", flags.provider)
	setOptionalQuery(query, "status", status)
	setOptionalQuery(query, "key_source", keySource)
	setOptionalQuery(query, "source_scope", flags.sourceScope)
	if bucket {
		bucketSeconds := flags.bucketSeconds
		if bucketSeconds == 0 {
			bucketSeconds = defaultActivityBucketSeconds(from, to)
		}
		if !allowedActivityBucketSeconds(bucketSeconds) {
			return nil, fmt.Errorf("invalid --bucket-seconds %d: expected 60, 300, 900, 1800, 86400, 604800, or 2592000", bucketSeconds)
		}
		if tooManyActivityBuckets(from, to, bucketSeconds) {
			return nil, fmt.Errorf("range would create more than 1000 time buckets; pick a larger --bucket-seconds")
		}
		query.Set("bucket_seconds", strconv.Itoa(bucketSeconds))
	}
	return query, nil
}

// defaultActivityBucketSeconds mirrors the dashboard's time-range picker so an
// unspecified bucket stays within the API's allowed set.
func defaultActivityBucketSeconds(from, to time.Time) int {
	duration := to.Sub(from)
	switch {
	case duration <= 3*time.Hour:
		return 60
	case duration <= 6*time.Hour:
		return 300
	case duration <= 24*time.Hour:
		return 900
	case duration <= 2*24*time.Hour:
		return 1800
	case duration <= 45*24*time.Hour:
		return 86400
	case duration <= 120*24*time.Hour:
		return 604800
	default:
		return 2592000
	}
}

func allowedActivityBucketSeconds(seconds int) bool {
	switch seconds {
	case 60, 300, 900, 1800, 86400, 604800, 2592000:
		return true
	default:
		return false
	}
}

func tooManyActivityBuckets(from, to time.Time, bucketSeconds int) bool {
	bucket := time.Duration(bucketSeconds) * time.Second
	return to.Sub(from) > 1000*bucket
}

func newActivityFiltersCmd(gf *globalFlags) *cobra.Command {
	flags := &activityFlags{}
	cmd := &cobra.Command{
		Use:   "filter-options",
		Short: "List users, API keys, routers, models, and providers available to activity filters",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			query, err := flags.query(false)
			if err != nil {
				return err
			}
			return requestActivity(cmd, gf, flags.organizationID, "filter-options", query)
		},
	}
	flags.add(cmd, false)
	return cmd
}

func newActivityOverviewCmd(gf *globalFlags) *cobra.Command {
	flags := &activityFlags{}
	cmd := &cobra.Command{
		Use:   "overview",
		Short: "Show usage, spend, savings, tokens, cache, models, and API keys",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			query, err := flags.query(true)
			if err != nil {
				return err
			}
			return requestActivity(cmd, gf, flags.organizationID, "overview", query)
		},
	}
	flags.add(cmd, true)
	return cmd
}

func newActivityModelsCmd(gf *globalFlags) *cobra.Command {
	flags := &activityFlags{}
	cmd := &cobra.Command{
		Use:     "models",
		Aliases: []string{"model-usage"},
		Short:   "Show model usage, cost, latency, outcomes, and route switches",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			query, err := flags.query(false)
			if err != nil {
				return err
			}
			return requestActivity(cmd, gf, flags.organizationID, "models", query)
		},
	}
	flags.add(cmd, false)
	return cmd
}

func newActivityPeopleCmd(gf *globalFlags) *cobra.Command {
	flags := &activityFlags{}
	var search, scope, sortBy, sortDirection string
	var limit, offset int
	cmd := &cobra.Command{
		Use:   "people",
		Short: "List activity attributed to people and API keys",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			query, err := flags.query(false)
			if err != nil {
				return err
			}
			if err := validateActivityList(scope, []string{"all", "people", "keys"}, sortBy, []string{"identity", "keys", "conversations", "messages", "tokens", "spend", "last_active"}, sortDirection, limit, offset); err != nil {
				return err
			}
			setOptionalQuery(query, "search", search)
			query.Set("identity_scope", scope)
			query.Set("sort_by", sortBy)
			query.Set("sort_direction", sortDirection)
			query.Set("limit", strconv.Itoa(limit))
			query.Set("offset", strconv.Itoa(offset))
			return requestActivity(cmd, gf, flags.organizationID, "people-keys", query)
		},
	}
	flags.add(cmd, false)
	f := cmd.Flags()
	f.StringVar(&search, "search", "", "Search person names, emails, or API keys")
	f.StringVar(&scope, "scope", "all", "Identity scope: all, people, or keys")
	f.StringVar(&sortBy, "sort-by", "last_active", "Sort by identity, keys, conversations, messages, tokens, spend, or last_active")
	f.StringVar(&sortDirection, "sort-direction", "desc", "Sort direction: asc or desc")
	f.IntVar(&limit, "limit", 50, "Maximum identities to return")
	f.IntVar(&offset, "offset", 0, "Number of identities to skip")
	cmd.AddCommand(newActivityPeopleSeriesCmd(gf))
	return cmd
}

func newActivityPeopleSeriesCmd(gf *globalFlags) *cobra.Command {
	flags := &activityFlags{}
	var comparisonUserIDs []string
	cmd := &cobra.Command{
		Use:   "series",
		Short: "Compare attributed people over time",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			query, err := flags.query(true)
			if err != nil {
				return err
			}
			setRepeatedQuery(query, "comparison_user_id", comparisonUserIDs)
			return requestActivity(cmd, gf, flags.organizationID, "people-series", query)
		},
	}
	flags.add(cmd, true)
	cmd.Flags().StringArrayVar(&comparisonUserIDs, "comparison-user-id", nil, "Include an attributed user in the comparison (repeatable)")
	return cmd
}

func newActivityConversationsCmd(gf *globalFlags) *cobra.Command {
	flags := &activityFlags{}
	var search, sortBy, sortDirection string
	var limit, offset int
	cmd := &cobra.Command{
		Use:   "conversations",
		Short: "List routed conversations",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			query, err := flags.query(false)
			if err != nil {
				return err
			}
			if err := validateActivityList("", nil, sortBy, []string{"last_active", "messages", "model_steps", "model_switches", "spend", "tokens"}, sortDirection, limit, offset); err != nil {
				return err
			}
			setOptionalQuery(query, "search", search)
			query.Set("sort_by", sortBy)
			query.Set("sort_direction", sortDirection)
			query.Set("limit", strconv.Itoa(limit))
			query.Set("offset", strconv.Itoa(offset))
			return requestActivity(cmd, gf, flags.organizationID, "conversations", query)
		},
	}
	flags.add(cmd, false)
	f := cmd.Flags()
	f.StringVar(&search, "search", "", "Search conversation identifiers and titles")
	f.StringVar(&sortBy, "sort-by", "last_active", "Sort by last_active, messages, model_steps, model_switches, spend, or tokens")
	f.StringVar(&sortDirection, "sort-direction", "desc", "Sort direction: asc or desc")
	f.IntVar(&limit, "limit", 50, "Maximum conversations to return (at most 100)")
	f.IntVar(&offset, "offset", 0, "Number of conversations to skip")
	cmd.AddCommand(newActivityConversationGetCmd(gf))
	return cmd
}

func newActivityConversationGetCmd(gf *globalFlags) *cobra.Command {
	var organizationID, requestClass, agentID string
	var limit, offset int
	var userTurns bool
	cmd := &cobra.Command{
		Use:   "get <conversation_ref>",
		Short: "Show the routed steps in one conversation",
		Long:  "Show the routed steps in one conversation. With --user-turns, print instead what the person typed, in order, read from the conversation's latest user message.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if userTurns {
				turns, err := conversationUserTurns(cmd, gf, organizationID, args[0])
				if err != nil {
					return err
				}
				return printJSON(turns)
			}
			if err := validateActivityPage(limit, offset); err != nil {
				return err
			}
			query := url.Values{"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}
			if requestClass != "" && !containsString([]string{"main", "subagent", "workflow", "auxiliary", "compaction", "side_reply", "unknown"}, requestClass) {
				return fmt.Errorf("invalid --request-class %q", requestClass)
			}
			setOptionalQuery(query, "request_class", requestClass)
			setOptionalQuery(query, "agent_id", agentID)
			endpoint := "conversations/" + url.PathEscape(args[0])
			return requestActivity(cmd, gf, organizationID, endpoint, query)
		},
	}
	f := cmd.Flags()
	f.StringVar(&organizationID, "organization-id", "", "Read an explicit organization using browser login")
	f.StringVar(&requestClass, "request-class", "", "Select main, subagent, workflow, auxiliary, compaction, side_reply, or unknown")
	f.StringVar(&agentID, "agent-id", "", "Select one agent's loop")
	f.IntVar(&limit, "limit", 100, "Maximum steps to return (at most 100)")
	f.IntVar(&offset, "offset", 0, "Number of steps to skip")
	f.BoolVar(&userTurns, "user-turns", false, "Print only the messages the person sent, oldest first")
	return cmd
}

var activityRequestParts = []string{"client-request", "client-response", "selector-output"}

func newActivityRequestCmd(gf *globalFlags) *cobra.Command {
	var organizationID, part string
	cmd := &cobra.Command{
		Use:   "request <request_id>",
		Short: "Show the stored request, response, or selector output of one routed step",
		Long:  "Show the stored body of one routed step, by the step id (rreq_...) that `dari activity conversations get` lists. The request holds the full conversation the agent sent, including what the person typed.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !containsString(activityRequestParts, part) {
				return fmt.Errorf("invalid --part %q: expected %s", part, strings.Join(activityRequestParts, ", "))
			}
			var body []byte
			if err := fetchActivity(cmd, gf, organizationID, "requests/"+url.PathEscape(args[0])+"/"+part, nil, &body); err != nil {
				return err
			}
			// Selector output is stored as plain text; the other parts are JSON.
			if !json.Valid(body) {
				_, err := fmt.Fprintln(cmd.OutOrStdout(), string(body))
				return err
			}
			var decoded any
			if err := json.Unmarshal(body, &decoded); err != nil {
				return err
			}
			return printJSON(decoded)
		},
	}
	f := cmd.Flags()
	f.StringVar(&organizationID, "organization-id", "", "Read an explicit organization using browser login")
	f.StringVar(&part, "part", "client-request", "Show client-request, client-response, or selector-output")
	return cmd
}

type activityStep struct {
	ID          string    `json:"id"`
	RequestKind string    `json:"request_kind"`
	ReceivedAt  time.Time `json:"received_at"`
	RequestURL  string    `json:"client_request_url"`
}

type activityUserTurns struct {
	ConversationRef string   `json:"conversation_ref"`
	RequestID       string   `json:"request_id"`
	UserTurns       []string `json:"user_turns"`
}

var systemReminder = regexp.MustCompile(`(?s)<system-reminder>.*?</system-reminder>`)

// conversationUserTurns reads the main agent's latest user message, whose
// stored request carries every earlier turn, and keeps the person's text.
func conversationUserTurns(cmd *cobra.Command, gf *globalFlags, organizationID, ref string) (activityUserTurns, error) {
	result := activityUserTurns{ConversationRef: ref, UserTurns: []string{}}
	var latest *activityStep
	for offset := 0; ; {
		var page struct {
			Steps      []activityStep `json:"steps"`
			HasMore    bool           `json:"has_more"`
			NextOffset int            `json:"next_offset"`
		}
		query := url.Values{"limit": {"100"}, "offset": {strconv.Itoa(offset)}, "request_class": {"main"}}
		if err := fetchActivity(cmd, gf, organizationID, "conversations/"+url.PathEscape(ref), query, &page); err != nil {
			return result, err
		}
		for i := range page.Steps {
			step := page.Steps[i]
			if step.RequestKind == "user_message" && step.RequestURL != "" && (latest == nil || step.ReceivedAt.After(latest.ReceivedAt)) {
				latest = &step
			}
		}
		if !page.HasMore || page.NextOffset <= offset {
			break
		}
		offset = page.NextOffset
	}
	if latest == nil {
		return result, nil
	}
	result.RequestID = latest.ID
	var request struct {
		Items    []map[string]any `json:"items"`
		Messages []map[string]any `json:"messages"`
	}
	if err := fetchActivity(cmd, gf, organizationID, "requests/"+url.PathEscape(latest.ID)+"/client-request", nil, &request); err != nil {
		return result, err
	}
	for _, message := range append(request.Items, request.Messages...) {
		if message["role"] != "user" || (message["type"] != nil && message["type"] != "message") {
			continue
		}
		text := strings.TrimSpace(systemReminder.ReplaceAllString(messageText(message["content"]), ""))
		if text != "" {
			result.UserTurns = append(result.UserTurns, text)
		}
	}
	return result, nil
}

func messageText(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		var parts []string
		for _, part := range value {
			if block, ok := part.(map[string]any); ok {
				if text, ok := block["text"].(string); ok && (block["type"] == "text" || block["type"] == "input_text") {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func newActivityCapabilitiesCmd(gf *globalFlags, mode string) *cobra.Command {
	flags := &activityFlags{}
	var seriesIDs []string
	pluralTitle := strings.ToUpper(mode[:1]) + mode[1:]
	cmd := &cobra.Command{
		Use:   mode,
		Short: "Show " + mode + " usage and time series",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			query, err := flags.query(true)
			if err != nil {
				return err
			}
			query.Set("mode", mode)
			setRepeatedQuery(query, "series_id", seriesIDs)
			return requestActivity(cmd, gf, flags.organizationID, "tools-skills", query)
		},
	}
	flags.add(cmd, true)
	cmd.Flags().StringArrayVar(&seriesIDs, "series-id", nil, "Include a capability in the time series (repeatable)")
	cmd.AddCommand(newActivityCapabilityListCmd(gf, mode), newActivityCapabilityGetCmd(gf, mode))
	cmd.Long = pluralTitle + " reports include totals, usage share, top capabilities, and selected time series."
	return cmd
}

func newActivityCapabilityListCmd(gf *globalFlags, mode string) *cobra.Command {
	flags := &activityFlags{}
	var search, sortBy, sortDirection string
	var limit, offset int
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List observed " + mode,
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			query, err := flags.query(false)
			if err != nil {
				return err
			}
			if err := validateActivityList("", nil, sortBy, []string{"name", "uses", "latest"}, sortDirection, limit, offset); err != nil {
				return err
			}
			query.Set("mode", mode)
			setOptionalQuery(query, "search", search)
			query.Set("sort_by", sortBy)
			query.Set("sort_direction", sortDirection)
			query.Set("limit", strconv.Itoa(limit))
			query.Set("offset", strconv.Itoa(offset))
			return requestActivity(cmd, gf, flags.organizationID, "tools-skills/inventory", query)
		},
	}
	flags.add(cmd, false)
	f := cmd.Flags()
	f.StringVar(&search, "search", "", "Search capability names and IDs")
	f.StringVar(&sortBy, "sort-by", "uses", "Sort by name, uses, or latest")
	f.StringVar(&sortDirection, "sort-direction", "desc", "Sort direction: asc or desc")
	f.IntVar(&limit, "limit", 50, "Maximum capabilities to return")
	f.IntVar(&offset, "offset", 0, "Number of capabilities to skip")
	return cmd
}

func newActivityCapabilityGetCmd(gf *globalFlags, mode string) *cobra.Command {
	flags := &activityFlags{}
	cmd := &cobra.Command{
		Use:   "get <capability_id>",
		Short: "Show details for one observed " + strings.TrimSuffix(mode, "s"),
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			query, err := flags.query(true)
			if err != nil {
				return err
			}
			query.Set("mode", mode)
			query.Set("capability_id", args[0])
			return requestActivity(cmd, gf, flags.organizationID, "tools-skills/detail", query)
		},
	}
	flags.add(cmd, true)
	return cmd
}

func validateActivityList(scope string, scopes []string, sortBy string, sortOptions []string, direction string, limit, offset int) error {
	if len(scopes) > 0 && !containsString(scopes, scope) {
		return fmt.Errorf("invalid --scope %q: expected %s", scope, strings.Join(scopes, ", "))
	}
	if !containsString(sortOptions, sortBy) {
		return fmt.Errorf("invalid --sort-by %q: expected %s", sortBy, strings.Join(sortOptions, ", "))
	}
	if direction != "asc" && direction != "desc" {
		return fmt.Errorf("invalid --sort-direction %q: expected asc or desc", direction)
	}
	return validateActivityPage(limit, offset)
}

// activityMaxPage is the largest page Activity serves.
const activityMaxPage = 100

func validateActivityPage(limit, offset int) error {
	if limit < 1 || limit > activityMaxPage {
		return fmt.Errorf("--limit must be between 1 and %d; page with --offset for more", activityMaxPage)
	}
	if offset < 0 {
		return fmt.Errorf("--offset cannot be negative")
	}
	return nil
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// requestActivity reads an Activity route from the gateway this machine
// routes through, or from hosted Dari's routing service, which serves
// Activity for the hosted API.
func requestActivity(cmd *cobra.Command, gf *globalFlags, organizationID, endpoint string, query url.Values) error {
	var response any
	if err := fetchActivity(cmd, gf, organizationID, endpoint, query, &response); err != nil {
		return err
	}
	return printJSON(response)
}

func fetchActivity(cmd *cobra.Command, gf *globalFlags, organizationID, endpoint string, query url.Values, response any) error {
	organizationID = strings.TrimSpace(organizationID)
	orgPath := "current"
	if organizationID != "" {
		orgPath = url.PathEscape(organizationID)
	}
	path := "/v1/organizations/" + orgPath + "/routing/activity/" + endpoint
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	if organizationID == "" {
		client, err := currentActivityClient(cmd, gf)
		if err != nil {
			return err
		}
		return client.Do(cmd.Context(), http.MethodGet, path, nil, response)
	}
	gw, err := currentGateway()
	if err != nil {
		return err
	}
	if gw != nil {
		return fmt.Errorf("--organization-id needs the hosted Dari API; a gateway serves its own activity")
	}
	if auth.EnvAPIKeyValue() != "" {
		return fmt.Errorf("--organization-id requires browser login; unset DARI_API_KEY and run `dari auth login`")
	}
	apiURL, err := gf.resolveAPIURL()
	if err != nil {
		return err
	}
	_, err = auth.DoAuthenticatedOn(cmd.Context(), apiURL, activityBaseURL(apiURL), http.MethodGet, path, nil, response)
	return err
}

// currentActivityClient reaches the current organization's Activity: on the
// gateway this machine routes through, or on hosted Dari's routing service.
func currentActivityClient(cmd *cobra.Command, gf *globalFlags) (*api.Client, error) {
	gw, err := currentGateway()
	if err != nil {
		return nil, err
	}
	if gw != nil {
		if err := gw.ensure(cmd.Context(), cmd.ErrOrStderr()); err != nil {
			return nil, err
		}
		return api.New(gw.url).WithBearer(gw.key), nil
	}
	apiURL, err := gf.resolveAPIURL()
	if err != nil {
		return nil, err
	}
	client, err := auth.OrgKeyClient(apiURL)
	if err != nil {
		return nil, err
	}
	client.BaseURL = activityBaseURL(apiURL)
	return client, nil
}

// activityBaseURL is the service that serves hosted Activity: the routing
// service for Dari's own API, and the API URL itself for any other (a test
// server or a stack that serves both).
func activityBaseURL(apiURL string) string {
	if api.URLsMatch(apiURL, api.DefaultAPIURL) {
		return routingBaseURL
	}
	return apiURL
}

func parseActivityTime(name, value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid --%s: expected RFC3339 timestamp: %w", name, err)
	}
	return parsed, nil
}

func validActivityStatus(value string) bool {
	switch value {
	case "completed", "provider_error", "selector_error", "aborted":
		return true
	default:
		return false
	}
}

func setOptionalQuery(query url.Values, name, value string) {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		query.Set(name, trimmed)
	}
}

func setRepeatedQuery(query url.Values, name string, values []string) {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			query.Add(name, trimmed)
		}
	}
}
