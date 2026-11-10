package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/api"
)

func TestSelectAgentModelsByNumberKeepsDefaultsOnEnter(t *testing.T) {
	models := testAgentModels()
	defaults := []string{"anthropic/claude-fable-5", "zai-org/GLM-5.3"}
	var output strings.Builder

	got, err := selectAgentModelsByNumber(strings.NewReader("\n"), &output, "Configure", nil, models, defaults, nil, testRecommendedLevels())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(choiceIDs(got), defaults) {
		t.Fatalf("selected = %q, want %q", choiceIDs(got), defaults)
	}
	if !strings.Contains(output.String(), "[x] Fable") || !strings.Contains(output.String(), "[x] GLM") {
		t.Fatalf("output does not mark defaults as selected:\n%s", output.String())
	}
}

func TestSelectAgentModelsByNumberAcceptsConfiguredList(t *testing.T) {
	got, err := selectAgentModelsByNumber(
		strings.NewReader("3, 1, 3\n"),
		io.Discard,
		"Configure",
		nil,
		testAgentModels(),
		[]string{"anthropic/claude-fable-5"},
		nil,
		testRecommendedLevels(),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"openai/gpt-5.6-sol", "anthropic/claude-fable-5"}
	if !slices.Equal(choiceIDs(got), want) {
		t.Fatalf("selected = %q, want %q", choiceIDs(got), want)
	}
}

func TestSelectAgentModelsByNumberRejectsInvalidSelection(t *testing.T) {
	_, err := selectAgentModelsByNumber(
		strings.NewReader("9\n"),
		io.Discard,
		"Configure", nil,
		testAgentModels(),
		nil,
		nil,
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "invalid model number") {
		t.Fatalf("error = %v", err)
	}
}

func TestSelectAgentModelsByNumberLeavesUnconsumedStdinForAgent(t *testing.T) {
	stdin := strings.NewReader("\nleftover agent input")
	_, err := selectAgentModelsByNumber(stdin, io.Discard, "Configure", nil, testAgentModels(), []string{"anthropic/claude-fable-5"}, nil, testRecommendedLevels())
	if err != nil {
		t.Fatal(err)
	}
	remaining, err := io.ReadAll(stdin)
	if err != nil {
		t.Fatal(err)
	}
	if string(remaining) != "leftover agent input" {
		t.Fatalf("unconsumed stdin = %q", remaining)
	}
}

func TestSelectAgentModelsByNumberPreservesCurrentLevels(t *testing.T) {
	models := testAgentModels()
	current := map[string][]string{"openai/gpt-5.6-sol": {"high"}}
	got, err := selectAgentModelsByNumber(
		strings.NewReader("3\n"),
		io.Discard,
		"Configure", nil,
		models,
		nil,
		current,
		testRecommendedLevels(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "openai/gpt-5.6-sol" {
		t.Fatalf("choices = %#v", got)
	}
	if !slices.Equal(got[0].Levels, []string{"high"}) {
		t.Fatalf("levels = %q, want current [high]", got[0].Levels)
	}
}

func TestAgentPickerTogglesModelsAndEditsLevels(t *testing.T) {
	models := testAgentModels()
	models[2].SupportedLevels = []string{"off", "low", "medium", "high", "xhigh", "max"}
	p := newAgentPickerState(models, []string{"anthropic/claude-fable-5", "zai-org/GLM-5.3"}, nil, testRecommendedLevels(), nil)

	// Sol starts with the recommended medium+xhigh set checked.
	if got := p.rows[2].checkedLevels(); !slices.Equal(got, []string{"medium", "xhigh"}) {
		t.Fatalf("Sol initial levels = %q", got)
	}
	if !p.rows[2].usesRecommended() {
		t.Fatal("Sol does not report using the recommended set")
	}

	// Move down to Sol, enable then disable it.
	p.handleKey("down")
	p.handleKey("down")
	if p.cursor != 2 {
		t.Fatalf("cursor = %d, want 2", p.cursor)
	}
	p.handleKey(" ")
	if !p.rows[2].selected {
		t.Fatal("Sol is not selected after space")
	}
	p.handleKey(" ")
	if p.rows[2].selected {
		t.Fatal("Sol is still selected after second space")
	}

	// Open level editing: cursor starts on the first checked level.
	p.handleKey("right")
	if !p.editing || p.levelCursor != 2 {
		t.Fatalf("editing = %v levelCursor = %d, want true 2 (medium)", p.editing, p.levelCursor)
	}

	// Check an extra level: medium -> down -> high -> space.
	p.handleKey("down")
	p.handleKey(" ")
	if got := p.rows[2].checkedLevels(); !slices.Equal(got, []string{"medium", "high", "xhigh"}) {
		t.Fatalf("levels = %q, want [medium high xhigh]", got)
	}
	if p.rows[2].usesRecommended() {
		t.Fatal("mixed levels still marked as recommended")
	}

	// Back on the model list, confirm.
	p.handleKey("left")
	if p.editing {
		t.Fatal("still editing after left")
	}
	done, canceled := p.handleKey("enter")
	if !done || canceled {
		t.Fatalf("enter = done %v canceled %v", done, canceled)
	}
	choices := p.choices()
	if len(choices) != 2 {
		t.Fatalf("choices = %#v", choices)
	}
	if !slices.Equal(choices[0].Levels, []string{"high"}) {
		t.Fatalf("Fable levels = %q", choices[0].Levels)
	}
}

func TestAgentPickerRecommendationsAreAgentSpecific(t *testing.T) {
	models := testAgentModels()
	codex := newAgentPickerState(
		models,
		[]string{"openai/gpt-5.6-sol"},
		nil,
		map[string][]string{"openai/gpt-5.6-sol": {"medium", "xhigh"}},
		nil,
	)
	if codex.rows[0].usesRecommended() {
		t.Fatal("Codex marked Fable as recommended")
	}
	if got := codex.rows[0].checkedLevels(); !slices.Equal(got, []string{"medium"}) {
		t.Fatalf("Codex Fable levels = %q, want catalog default [medium]", got)
	}
	if !codex.rows[2].usesRecommended() {
		t.Fatal("Codex did not mark Sol as recommended")
	}

	claude := newAgentPickerState(
		models,
		[]string{"anthropic/claude-fable-5", "zai-org/GLM-5.3"},
		nil,
		map[string][]string{
			"anthropic/claude-fable-5": {"high"},
			"zai-org/GLM-5.3":          {"high"},
		},
		nil,
	)
	if !claude.rows[0].usesRecommended() {
		t.Fatal("Claude Code did not mark Fable as recommended")
	}
	if claude.rows[2].usesRecommended() {
		t.Fatal("Claude Code marked Sol as recommended")
	}
}

func TestAgentPickerLevelEditingRestoresRecommendedWhenEmptied(t *testing.T) {
	models := testAgentModels()
	models[2].SupportedLevels = []string{"off", "low", "medium", "high", "xhigh", "max"}
	p := newAgentPickerState(models, []string{"openai/gpt-5.6-sol"}, nil, testRecommendedLevels(), nil)

	// Open Sol's levels and uncheck everything.
	p.handleKey("down")
	p.handleKey("down")
	p.handleKey("right")
	p.handleKey(" ")    // uncheck medium
	p.handleKey("down") // high
	p.handleKey("down") // xhigh
	p.handleKey(" ")    // uncheck xhigh
	if got := p.rows[2].checkedLevels(); len(got) != 0 {
		t.Fatalf("levels = %q, want none", got)
	}

	// Leaving level editing falls back to the recommended set.
	p.handleKey("left")
	if got := p.rows[2].checkedLevels(); !slices.Equal(got, []string{"medium", "xhigh"}) {
		t.Fatalf("levels after exit = %q, want recommended [medium xhigh]", got)
	}
}

func TestAgentPickerKeyParsing(t *testing.T) {
	got := parseAgentPickerKeys([]byte("\x1b[B\x1b[C j\r"))
	want := []string{"down", "right", " ", "j", "enter"}
	if !slices.Equal(got, want) {
		t.Fatalf("keys = %q, want %q", got, want)
	}
	if got := parseAgentPickerKeys([]byte("\x03")); !slices.Equal(got, []string{"quit"}) {
		t.Fatalf("ctrl-c = %q, want [quit]", got)
	}
	if got := parseAgentPickerKeys([]byte("\x1b")); !slices.Equal(got, []string{"esc"}) {
		t.Fatalf("esc = %q, want [esc]", got)
	}
}

func TestAgentPickerRowKeepsCustomCurrentLevels(t *testing.T) {
	model := agentModel{
		ID:              "zai-org/GLM-5.3",
		SupportedLevels: []string{"low", "high", "max"},
	}
	row := newAgentPickerRow(model, []string{"max"}, []string{"high"})
	if got := row.checkedLevels(); !slices.Equal(got, []string{"max"}) {
		t.Fatalf("levels = %q, want current [max]", got)
	}
	if row.usesRecommended() {
		t.Fatal("custom levels reported as recommended")
	}

	// A current level outside the supported list stays selectable.
	row = newAgentPickerRow(model, []string{"medium"}, []string{"high"})
	if !slices.Contains(row.levelOpts, "medium") {
		t.Fatalf("level options = %q, want to include current medium", row.levelOpts)
	}
	if got := row.checkedLevels(); !slices.Equal(got, []string{"medium"}) {
		t.Fatalf("levels = %q, want [medium]", got)
	}
}

func TestResolveClaudePersonalSubscriptionUsesExistingConnection(t *testing.T) {
	var requests int
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodGet || r.URL.Path != "/v1/organizations/current/credentials" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		writeClaudeSubscriptionCredential(w)
	}))
	defer server.Close()

	var stderr strings.Builder
	resolution, err := resolveAgentPersonalSubscription(
		context.Background(),
		[]agentSubscriptionProvider{claudeSubscription},
		api.New(server.URL),
		strings.NewReader("n\n"),
		&stderr,
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !resolution.enabled || !resolution.decided || !resolution.preferenceChanged {
		t.Fatalf("resolution = %#v, want enabled with cleared opt-out", resolution)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
	if stderr.Len() != 0 {
		t.Fatalf("unexpected prompt: %q", stderr.String())
	}
}

func TestResolveClaudePersonalSubscriptionNeedsNoPlan(t *testing.T) {
	var requests int
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodGet || r.URL.Path != "/v1/organizations/current/credentials" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"credentials":         []any{map[string]any{"oauth_provider": "anthropic_claude_code"}},
			"autorouting_allowed": false,
		})
	}))
	defer server.Close()

	var stderr strings.Builder
	resolution, err := resolveAgentPersonalSubscription(
		context.Background(),
		[]agentSubscriptionProvider{claudeSubscription},
		api.New(server.URL),
		strings.NewReader(""),
		&stderr,
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !resolution.enabled || !resolution.decided {
		t.Fatalf("resolution = %#v, want the connected subscription without a plan", resolution)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
	if stderr.Len() != 0 {
		t.Fatalf("unexpected prompt:\n%s", stderr.String())
	}
}

func TestResolveClaudePersonalSubscriptionDefaultsToConnect(t *testing.T) {
	var completed map[string]any
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/credentials/oauth/sessions":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if got := body["provider"]; got != "anthropic_claude_code" {
				t.Errorf("provider = %#v", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"session_token":     "oauth_session",
				"authorization_url": "https://claude.example.test/authorize",
			})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/credentials/oauth/sessions/complete":
			if err := json.NewDecoder(r.Body).Decode(&completed); err != nil {
				t.Error(err)
			}
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	originalOpenBrowser := openAgentBrowser
	openAgentBrowser = func(string) bool { return false }
	t.Cleanup(func() { openAgentBrowser = originalOpenBrowser })

	var stderr strings.Builder
	resolution, err := resolveAgentPersonalSubscription(
		context.Background(),
		[]agentSubscriptionProvider{claudeSubscription},
		api.New(server.URL),
		strings.NewReader("\ntest-code#test-state\n"),
		&stderr,
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !resolution.enabled || !resolution.decided || !resolution.preferenceChanged {
		t.Fatalf("resolution = %#v, want enabled from default answer", resolution)
	}
	if got := completed["session_token"]; got != "oauth_session" {
		t.Errorf("session_token = %#v", got)
	}
	if got := completed["authorization_response"]; got != "test-code#test-state" {
		t.Errorf("authorization_response = %#v", got)
	}
	for _, text := range []string{
		"Use your Claude Code personal subscription? [Y/n]",
		"Open this URL to connect your Claude Code subscription",
		"paste the authorization code Anthropic shows",
		"Claude Code subscription connected",
	} {
		if !strings.Contains(stderr.String(), text) {
			t.Errorf("stderr missing %q:\n%s", text, stderr.String())
		}
	}
}

func TestClaudeOAuthPromptKeepsURLWhole(t *testing.T) {
	url := "https://claude.example.test/authorize?" + strings.Repeat("a", 120)
	lines := agentOAuthLines(claudeSubscription, url, true, "", 80)
	// Wrapped pieces stay inside the indent and link to the whole URL.
	for _, line := range lines[2:4] {
		if ansiVisibleWidth(line) > 80 || !strings.HasPrefix(line, "  ") || !strings.Contains(line, "\033]8;;"+url+"\033\\") {
			t.Fatalf("URL line %q", line)
		}
	}
	output := stripANSI(strings.Join(lines, "\n"))
	output = regexp.MustCompile(`\x1b\]8;;[^\x1b]*\x1b\\`).ReplaceAllString(output, "")
	output = strings.ReplaceAll(output, "\n  ", "")
	for _, text := range []string{"Connect Claude Code", "Opened Claude Code in your browser", url, "code#state"} {
		if !strings.Contains(output, text) {
			t.Errorf("OAuth prompt missing %q:\n%s", text, output)
		}
	}
}
func TestClaudeCodeInputIgnoresSplitTerminalEscapes(t *testing.T) {
	input := agentCodeInputState{}
	chunks := [][]byte{
		[]byte("\x1b["),
		[]byte("A\x1b[20"),
		[]byte("0~test-code#test-state\x1b[2"),
		[]byte("01~\r"),
	}
	var submitted, canceled bool
	for _, chunk := range chunks {
		submitted, canceled = input.update(chunk)
	}
	if !submitted || canceled {
		t.Fatalf("submitted = %t, canceled = %t", submitted, canceled)
	}
	if want := "test-code#test-state"; input.value != want {
		t.Fatalf("input = %q, want %q", input.value, want)
	}
}

func TestClaudeCodeInputCtrlCCancels(t *testing.T) {
	input := agentCodeInputState{value: "partial"}
	submitted, canceled := input.update([]byte{0x03})
	if input.value != "partial" || submitted || !canceled {
		t.Fatalf("input = %q, submitted = %t, canceled = %t", input.value, submitted, canceled)
	}
}

func TestResolveClaudePersonalSubscriptionDoesNotDefaultOnEOF(t *testing.T) {
	var requests int
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodGet || r.URL.Path != "/v1/organizations/current/credentials" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})
	}))
	defer server.Close()

	resolution, err := resolveAgentPersonalSubscription(
		context.Background(),
		[]agentSubscriptionProvider{claudeSubscription},
		api.New(server.URL),
		strings.NewReader(""),
		io.Discard,
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if resolution.enabled || resolution.decided || resolution.preferenceChanged {
		t.Fatalf("resolution = %#v, want no decision on EOF", resolution)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want credentials request only", requests)
	}
}

func TestResolveClaudePersonalSubscriptionPreservesOptOut(t *testing.T) {
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/organizations/current/credentials" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})
	}))
	defer server.Close()

	var stderr strings.Builder
	resolution, err := resolveAgentPersonalSubscription(
		context.Background(),
		[]agentSubscriptionProvider{claudeSubscription},
		api.New(server.URL),
		strings.NewReader("\n"),
		&stderr,
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if resolution.enabled || !resolution.decided || resolution.preferenceChanged {
		t.Fatalf("resolution = %#v, want persisted opt-out", resolution)
	}
	if stderr.Len() != 0 {
		t.Fatalf("unexpected prompt after persisted opt-out: %q", stderr.String())
	}
}

func TestResolveClaudePersonalSubscriptionAllowsOptOut(t *testing.T) {
	var requests int
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodGet || r.URL.Path != "/v1/organizations/current/credentials" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})
	}))
	defer server.Close()

	resolution, err := resolveAgentPersonalSubscription(
		context.Background(),
		[]agentSubscriptionProvider{claudeSubscription},
		api.New(server.URL),
		strings.NewReader("n\n"),
		io.Discard,
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if resolution.enabled || !resolution.decided || !resolution.preferenceChanged {
		t.Fatalf("resolution = %#v, want saved opt-out", resolution)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
}

func TestEnsureClaudeAgentRouterCreatesSeparateRouter(t *testing.T) {
	var created map[string]any
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer dari_test" {
			t.Errorf("Authorization = %q", got)
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{
				{
					"id":                    "rtr_default",
					"name":                  "Default",
					"is_default":            true,
					"enabled_models":        []string{"openai/gpt-5.6-sol"},
					"model_thinking_levels": map[string][]string{"openai/gpt-5.6-sol": {"medium", "xhigh"}},
				},
				{
					"id":   "rtr_same_name",
					"name": ownRouterName("claude", true),
				},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			writeClaudeSubscriptionCredential(w)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
			writeAgentModelCatalog(t, w)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-suggestions":
			writeAgentModelSuggestions(t, w)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/routers":
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Error(err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_claude", "name": ownRouterName("claude", true)})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	useTestAPIKey(t)
	t.Setenv("DARI_API_URL", server.URL)
	routerID, err := ensureAgentRouter(
		context.Background(),
		"claude",
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader("\n"),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	if routerID != "rtr_claude" {
		t.Fatalf("router ID = %q", routerID)
	}
	if got := created["name"]; got != ownRouterName("claude", true) {
		t.Errorf("name = %#v", got)
	}
	if got := created["client_key"]; got != ownRouterKey("claude", true) {
		t.Errorf("client_key = %#v", got)
	}
	if got := created["coding_agent"]; got != "claude_code" {
		t.Errorf("coding_agent = %#v", got)
	}
	if got := stringSlice(created["subscription_providers"]); !slices.Equal(got, []string{"anthropic"}) {
		t.Errorf("subscription_providers = %q", got)
	}
	if got, ok := created["subscription_api_fallback_models"].([]any); !ok || len(got) != 0 {
		t.Errorf("subscription_api_fallback_models = %#v, want []", created["subscription_api_fallback_models"])
	}
	if _, ok := created["personal_oauth_enabled"]; ok {
		t.Errorf("create payload still sends personal_oauth_enabled")
	}
	if _, ok := created["eval_ids"]; ok {
		t.Errorf("create payload unexpectedly includes eval_ids: %#v", created["eval_ids"])
	}
	if got := stringSlice(created["enabled_models"]); !slices.Equal(got, []string{
		"anthropic/claude-fable-5-1",
		"zai-org/GLM-5.3-Flash",
		"xai/grok-4.7",
		"openai/gpt-5.6-sol",
	}) {
		t.Errorf("enabled_models = %q", got)
	}
	levels, _ := created["model_thinking_levels"].(map[string]any)
	for modelID, want := range map[string][]string{
		"anthropic/claude-fable-5-1": {"high"},
		"zai-org/GLM-5.3-Flash":      {"high"},
		"xai/grok-4.7":               {"high"},
		"openai/gpt-5.6-sol":         {"medium"},
	} {
		if got := stringSlice(levels[modelID]); !slices.Equal(got, want) {
			t.Errorf("%s thinking levels = %q, want %q", modelID, got, want)
		}
	}
}

func TestOwnAgentRouterUsesManagedRouterAfterOptOut(t *testing.T) {
	for _, agent := range []string{"claude", "codex"} {
		t.Run(agent, func(t *testing.T) {
			var created map[string]any
			var putRequests int
			server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
					_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{
						{
							"id":                    "rtr_default",
							"name":                  "Default",
							"is_default":            true,
							"enabled_models":        []string{"openai/gpt-5.6-sol"},
							"model_thinking_levels": map[string][]string{"openai/gpt-5.6-sol": {"medium"}},
						},
						{
							"id":                     "rtr_personal",
							"name":                   ownRouterName(agent, true),
							"client_key":             ownRouterKey(agent, true),
							"subscription_providers": []string{"anthropic"},
						},
					}})
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
					_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
					writeAgentModelCatalog(t, w)
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-suggestions":
					writeAgentModelSuggestions(t, w)
				case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/routers":
					if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
						t.Error(err)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_managed", "name": ownRouterName(agent, false)})
				case r.Method == http.MethodPut:
					putRequests++
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			useTestAPIKey(t)
			t.Setenv("DARI_API_URL", server.URL)
			routerID, err := ensureAgentRouter(
				context.Background(),
				agent,
				agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
				strings.NewReader("n\n\n"),
				io.Discard,
			)
			if err != nil {
				t.Fatal(err)
			}
			if routerID != "rtr_managed" {
				t.Fatalf("router ID = %q", routerID)
			}
			if putRequests != 0 {
				t.Fatalf("PUT requests = %d, want no mutation of personal router", putRequests)
			}
			if got := created["client_key"]; got != ownRouterKey(agent, false) {
				t.Errorf("client_key = %#v", got)
			}
			if got := created["name"]; got != ownRouterName(agent, false) {
				t.Errorf("name = %#v", got)
			}
			if got, ok := created["subscription_providers"].([]any); !ok || len(got) != 0 {
				t.Errorf("subscription_providers = %#v, want []", created["subscription_providers"])
			}
		})
	}
}

func TestEnsureClaudeAgentRouterAvoidsPersonalRouterWithoutCredentialsOnEOF(t *testing.T) {
	var writeRequests int
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{
				{"id": "rtr_default", "name": "Default", "is_default": true},
				{
					"id":                     "rtr_claude",
					"name":                   ownRouterName("claude", true),
					"client_key":             ownRouterKey("claude", true),
					"subscription_providers": []string{"anthropic"},
				},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})
		case r.Method == http.MethodPost || r.Method == http.MethodPut:
			writeRequests++
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	useTestAPIKey(t)
	routerID, err := ensureAgentRouter(
		context.Background(),
		"claude",
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader(""),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	if routerID != "rtr_default" {
		t.Fatalf("router ID = %q, want default router", routerID)
	}
	if writeRequests != 0 {
		t.Fatalf("router write requests = %d, want 0", writeRequests)
	}
}

func TestEnsureClaudeAgentRouterUsesServerManagedRouterOnEOF(t *testing.T) {
	useTestAPIKey(t)

	var writeRequests int
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{
				{"id": "rtr_default", "name": "Default", "is_default": true},
				{"id": "rtr_managed_other", "client_key": ownRouterKey("claude", false), "coding_agents": []string{"claude_code"}},
				{"id": "rtr_managed_cached", "client_key": ownRouterKey("claude", false)},
				{"id": "rtr_personal", "client_key": ownRouterKey("claude", true)},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})
		case r.Method == http.MethodPost || r.Method == http.MethodPut:
			writeRequests++
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	routerID, err := ensureAgentRouter(
		context.Background(),
		"claude",
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader(""),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	if routerID != "rtr_managed_other" {
		t.Fatalf("router ID = %q, want server managed router", routerID)
	}
	if writeRequests != 0 {
		t.Fatalf("router write requests = %d, want 0", writeRequests)
	}
}

func TestEnsureClaudeAgentRouterIgnoresUnavailablePersonalRouterOnEOF(t *testing.T) {
	useTestAPIKey(t)

	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{
				{"id": "rtr_default", "name": "Default", "is_default": true},
				{"id": "rtr_managed", "client_key": ownRouterKey("claude", false), "coding_agents": []string{"claude_code"}},
				{"id": "rtr_personal", "client_key": ownRouterKey("claude", true)},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	routerID, err := ensureAgentRouter(
		context.Background(),
		"claude",
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader(""),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	if routerID != "rtr_managed" {
		t.Fatalf("router ID = %q, want managed router", routerID)
	}
}

func TestEnsureClaudeAgentRouterRequiresSubscriptionAfterRename(t *testing.T) {
	var updated map[string]any
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{
				{"id": "rtr_default", "name": "Default", "is_default": true},
				{
					"id":                     "rtr_claude",
					"name":                   "Renamed by user",
					"client_key":             ownRouterKey("claude", true),
					"coding_agents":          []string{"claude_code"},
					"enabled_models":         []string{"anthropic/claude-fable-5", "openai/gpt-5.6-sol"},
					"model_providers":        map[string]string{"anthropic/claude-fable-5": "anthropic", "openai/gpt-5.6-sol": "openai"},
					"model_thinking_levels":  map[string][]string{"anthropic/claude-fable-5": {"high"}, "openai/gpt-5.6-sol": {"medium"}},
					"subscription_providers": []string{"openai"},
				},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			writeClaudeSubscriptionCredential(w)
		case r.Method == http.MethodPut && r.URL.Path == "/v1/organizations/current/routers/rtr_claude":
			if err := json.NewDecoder(r.Body).Decode(&updated); err != nil {
				t.Error(err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_claude"})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	useTestAPIKey(t)
	routerID, err := ensureAgentRouter(
		context.Background(),
		"claude",
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader(""),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	if routerID != "rtr_claude" {
		t.Fatalf("router ID = %q", routerID)
	}
	// Claude Code adds its own provider and leaves the router's other
	// subscriptions and API fallback models alone.
	if got := stringSlice(updated["subscription_providers"]); !slices.Equal(got, []string{"openai", "anthropic"}) {
		t.Errorf("subscription_providers = %q", got)
	}
	if _, ok := updated["subscription_api_fallback_models"]; ok {
		t.Errorf("update must keep the router's API fallback models: %#v", updated["subscription_api_fallback_models"])
	}
	if got := updated["name"]; got != "Renamed by user" {
		t.Errorf("name = %#v", got)
	}
	if got := stringSlice(updated["enabled_models"]); !slices.Equal(got, []string{"anthropic/claude-fable-5", "openai/gpt-5.6-sol"}) {
		t.Errorf("enabled_models = %q", got)
	}
}

func TestEnsureClaudeAgentRouterSkipsUpdateForCompliantRouter(t *testing.T) {
	var putRequests int
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{
				{"id": "rtr_default", "name": "Default", "is_default": true},
				{
					"id":                     "rtr_claude",
					"name":                   "Renamed by user",
					"client_key":             ownRouterKey("claude", true),
					"coding_agents":          []string{"claude_code"},
					"subscription_providers": []string{"anthropic"},
				},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			writeClaudeSubscriptionCredential(w)
		case r.Method == http.MethodPut:
			putRequests++
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_claude"})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	useTestAPIKey(t)
	t.Setenv("DARI_API_URL", server.URL)
	routerID, err := ensureAgentRouter(
		context.Background(),
		"claude",
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader(""),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	if routerID != "rtr_claude" {
		t.Fatalf("router ID = %q", routerID)
	}
	if putRequests != 0 {
		t.Fatalf("PUT requests = %d, want 0", putRequests)
	}
}

func TestEnsureClaudeAgentRouterRecoversFromConcurrentCreate(t *testing.T) {
	var routerLists int
	var subscriptionUpdated bool
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			routerLists++
			routers := []map[string]any{{
				"id": "rtr_default", "name": "Default", "is_default": true,
			}}
			if routerLists > 1 {
				routers = append(routers, map[string]any{
					"id":              "rtr_other_computer",
					"name":            "Renamed",
					"client_key":      ownRouterKey("claude", true),
					"enabled_models":  []string{"anthropic/claude-fable-5"},
					"model_providers": map[string]string{"anthropic/claude-fable-5": "anthropic"},
				})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": routers})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			writeClaudeSubscriptionCredential(w)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
			writeAgentModelCatalog(t, w)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-suggestions":
			writeAgentModelSuggestions(t, w)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/routers":
			http.Error(w, `{"detail":"client key already exists"}`, http.StatusConflict)
		case r.Method == http.MethodPut && r.URL.Path == "/v1/organizations/current/routers/rtr_other_computer":
			var updated map[string]any
			if err := json.NewDecoder(r.Body).Decode(&updated); err != nil {
				t.Error(err)
			}
			subscriptionUpdated = slices.Equal(stringSlice(updated["subscription_providers"]), []string{"anthropic"})
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_other_computer"})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	useTestAPIKey(t)
	routerID, err := ensureAgentRouter(
		context.Background(),
		"claude",
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader("\n"),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	if routerID != "rtr_other_computer" {
		t.Fatalf("router ID = %q", routerID)
	}
	if routerLists != 2 {
		t.Fatalf("router list requests = %d, want 2", routerLists)
	}
	if !subscriptionUpdated {
		t.Fatal("recovered router was not updated to require a personal subscription")
	}
}

func TestEnsurePiAgentRouterPreservesSavedDefault(t *testing.T) {
	var putRequests int
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-suggestions":
			_ = json.NewEncoder(w).Encode(map[string]any{"suggestions": []map[string]any{{
				"id": "codex", "models": map[string][]string{"anthropic/claude-fable-5": {"high"}, "zai-org/GLM-5.3": {"high"}},
			}}})

		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})

		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{{
				"id":             "rtr_default",
				"name":           "Custom Default",
				"is_default":     true,
				"enabled_models": []string{"custom/model"},
			}}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
			writeAgentModelCatalog(t, w)
		case r.Method == http.MethodPut:
			putRequests++
			var body agentRouterUpdateRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(body.EnabledModels, []string{"anthropic/claude-fable-5", "zai-org/GLM-5.3"}) {
				t.Fatalf("models = %v", body.EnabledModels)
			}
			if !slices.Equal(body.ModelThinkingLevels["zai-org/GLM-5.3"], []string{"high"}) {
				t.Fatalf("levels = %v", body.ModelThinkingLevels)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_default"})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	useTestAPIKey(t)
	t.Setenv("DARI_API_URL", server.URL)
	routerID, err := ensureAgentRouter(
		context.Background(),
		"pi",
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader("n\n\n"),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	if routerID != "rtr_default" {
		t.Fatalf("router ID = %q", routerID)
	}
	if putRequests != 0 {
		t.Fatalf("PUT requests = %d, want 0", putRequests)
	}
}

func TestEnsureClaudeAgentRouterExplainsModelsByPlan(t *testing.T) {
	for _, allowed := range []bool{true, false} {
		server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-suggestions":
				_ = json.NewEncoder(w).Encode(map[string]any{"suggestions": []map[string]any{
					{"id": "claude", "models": map[string][]string{"zai-org/GLM-5.3": {"high"}}},
				}})
			case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
				_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}, "autorouting_allowed": allowed})
			case r.Method == http.MethodGet && r.URL.Path == "/v1/auth/config":
				_ = json.NewEncoder(w).Encode(map[string]any{"web_app_url": "https://app.example.test"})
			case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
				_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{{"id": "rtr_default", "is_default": true}}})
			case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
				writeAgentModelCatalog(t, w)
			case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/routers":
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_claude"})
			default:
				t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				http.NotFound(w, r)
			}
		}))
		useTestAPIKey(t)
		t.Setenv("DARI_API_URL", server.URL)
		if err := saveAgentSubscriptionOptOut(context.Background(), api.New(server.URL), "claude", true); err != nil {
			t.Fatal(err)
		}
		var output strings.Builder
		_, err := ensureAgentRouter(
			context.Background(),
			"claude",
			agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
			strings.NewReader("\n"),
			&output,
		)
		server.Close()
		if err != nil {
			t.Fatal(err)
		}
		// Setup always asks; the note says how the models get used.
		want := "Auto-routing picks the best of these"
		if !allowed {
			want = "Switch between them with /model.\nRun `dari claude --connect` to get auto-routing ($20/mo)"
		}
		if !strings.Contains(output.String(), "Choose models for Claude Code") || !strings.Contains(output.String(), want) {
			t.Errorf("allowed=%v: output missing %q:\n%s", allowed, want, output.String())
		}
	}
}

func TestEnsureSharedAgentRouterUsesDefaultPreset(t *testing.T) {
	for _, agent := range []string{"pi", "opencode"} {
		t.Run(agent, func(t *testing.T) {
			var putRequests int
			server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-suggestions":
					_ = json.NewEncoder(w).Encode(map[string]any{"suggestions": []map[string]any{
						{"id": "default", "models": map[string][]string{"openai/gpt-5.6-sol": {"medium"}}},
						{"id": "codex", "models": map[string][]string{"zai-org/GLM-5.3": {"high"}}},
					}})
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
					_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}, "personal_subscriptions_allowed": true})
				case r.Method == http.MethodGet && r.URL.Path == "/v1/auth/config":
					_ = json.NewEncoder(w).Encode(map[string]any{"personal_subscriptions_allowed": false, "web_app_url": "https://app.dari.dev"})
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
					_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{{
						"id": "rtr_default", "name": "Default", "is_default": true,
						"enabled_models":        []string{},
						"model_thinking_levels": map[string][]string{"zai-org/GLM-5.3": {"high"}},
					}}})
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
					writeAgentModelCatalog(t, w)
				case r.Method == http.MethodPut:
					putRequests++
					var body agentRouterUpdateRequest
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Fatal(err)
					}
					if !slices.Equal(body.EnabledModels, []string{"openai/gpt-5.6-sol"}) {
						t.Fatalf("models = %v, want default preset", body.EnabledModels)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_default"})
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			useTestAPIKey(t)
			if err := saveAgentSubscriptionOptOut(context.Background(), api.New(server.URL), agent, true); err != nil {
				t.Fatal(err)
			}
			t.Setenv("DARI_API_URL", server.URL)
			var output strings.Builder
			routerID, err := ensureAgentRouter(
				context.Background(),
				agent,
				agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
				strings.NewReader("\n"),
				&output,
			)
			if err != nil {
				t.Fatal(err)
			}
			if routerID != "rtr_default" {
				t.Fatalf("router ID = %q", routerID)
			}
			if putRequests != 1 {
				t.Fatalf("PUT requests = %d, want Pi to apply the default preset", putRequests)
			}
			name := "Pi"
			if agent == "opencode" {
				name = "OpenCode"
			}
			if !strings.Contains(output.String(), "Choose models for "+name) || !strings.Contains(output.String(), name+" will use your default router") {
				t.Fatalf("output does not identify %s setup: %s", name, output.String())
			}
		})
	}
}

func writeClaudeSubscriptionCredential(w http.ResponseWriter) {
	_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []map[string]any{{
		"oauth_provider": "anthropic_claude_code",
	}}})
}

func TestListAgentModelsIncludesGPT6ReasoningLevels(t *testing.T) {
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/organizations/current/routers/model-catalog" {
			t.Fatalf("unexpected request path %q", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"groups": []map[string]any{{
			"supports_managed_key": true,
			"models": []map[string]any{
				{
					"id": "openai/gpt-6-sol", "display_name": "GPT-6 Sol", "provider": "openai",
					"default_provider": "openai", "default_thinking_level": "medium", "supports_managed_key": true,
					"supported_thinking_levels": []string{"off", "low", "medium", "high", "xhigh", "max"},
				},
				{
					"id": "openai/gpt-6-luna", "display_name": "GPT-6 Luna", "provider": "openai",
					"default_provider": "openai", "default_thinking_level": "medium", "supports_managed_key": true,
					"supported_thinking_levels": []string{"off", "low", "medium", "high", "xhigh", "max"},
				},
			},
		}}})
	}))
	defer server.Close()

	models, err := listAgentModels(context.Background(), api.New(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %#v", models)
	}
	// The CLI sorts the dynamic API catalog for display and preserves every
	// supported level so the nested picker can change reasoning independently.
	if models[0].ID != "openai/gpt-6-luna" || models[1].ID != "openai/gpt-6-sol" {
		t.Fatalf("model order = %q, %q", models[0].ID, models[1].ID)
	}
	wantLevels := []string{"off", "low", "medium", "high", "xhigh", "max"}
	for _, model := range models {
		if !slices.Equal(model.SupportedLevels, wantLevels) {
			t.Fatalf("%s levels = %q, want %q", model.ID, model.SupportedLevels, wantLevels)
		}
	}
}

func writeAgentModelCatalog(t *testing.T, w http.ResponseWriter) {
	t.Helper()
	_ = json.NewEncoder(w).Encode(map[string]any{"groups": []map[string]any{{
		"provider":             "managed",
		"supports_managed_key": true,
		"models": []map[string]any{
			{"id": "anthropic/claude-fable-5-1", "display_name": "Fable 5.1", "provider": "anthropic", "default_provider": "anthropic", "default_thinking_level": "high", "supports_managed_key": true},
			{"id": "openai/gpt-5.6-sol", "display_name": "Sol", "provider": "openai", "default_provider": "openai", "default_thinking_level": "medium", "supports_managed_key": true},
			{"id": "zai-org/GLM-5.3-Flash", "display_name": "GLM Flash", "provider": "fireworks", "default_provider": "fireworks", "default_thinking_level": "high", "supports_managed_key": true},
			{"id": "xai/grok-4.7", "display_name": "Grok", "provider": "xai", "default_provider": "xai", "default_thinking_level": "high", "supports_managed_key": true},
			{"id": "zai-org/GLM-5.3", "display_name": "GLM", "provider": "fireworks", "default_provider": "fireworks", "default_thinking_level": "high", "supports_managed_key": true},
		},
	}}})
}

func writeAgentModelSuggestions(t *testing.T, w http.ResponseWriter) {
	t.Helper()
	_ = json.NewEncoder(w).Encode(map[string]any{
		"suggestions": []map[string]any{agentModelSuggestionFixture("claude"), agentModelSuggestionFixture("codex")},
	})
}

func ownRouterKey(agent string, personal bool) string {
	key, _ := agentSetups[agent].ownRouter(personal)
	return key
}

func ownRouterName(agent string, personal bool) string {
	_, name := agentSetups[agent].ownRouter(personal)
	return name
}

func agentModelSuggestionFixture(id string) map[string]any {
	return map[string]any{
		"id": id,
		"model_ids": []string{
			"anthropic/claude-fable-5-1",
			"zai-org/GLM-5.3-Flash",
			"xai/grok-4.7",
			"openai/gpt-5.6-sol",
		},
		"models": map[string]any{
			"anthropic/claude-fable-5-1": []string{"high"},
			"zai-org/GLM-5.3-Flash":      []string{"high"},
			"xai/grok-4.7":               []string{"high"},
			"openai/gpt-5.6-sol":         []string{"medium"},
		},
	}
}

func stringSlice(value any) []string {
	values, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		text, _ := value.(string)
		result = append(result, text)
	}
	return result
}

func testRecommendedLevels() map[string][]string {
	return map[string][]string{
		"anthropic/claude-fable-5": {"high"},
		"zai-org/GLM-5.3":          {"high"},
		"openai/gpt-5.6-sol":       {"medium", "xhigh"},
	}
}

func testAgentModels() []agentModel {
	return []agentModel{
		{
			ID:                   "anthropic/claude-fable-5",
			DisplayName:          "Fable",
			Provider:             "anthropic",
			DefaultProvider:      "anthropic",
			DefaultThinkingLevel: "medium",
		},
		{
			ID:                   "zai-org/GLM-5.3",
			DisplayName:          "GLM",
			Provider:             "fireworks",
			DefaultProvider:      "fireworks",
			DefaultThinkingLevel: "high",
		},
		{
			ID:                   "openai/gpt-5.6-sol",
			DisplayName:          "Sol",
			Provider:             "openai",
			DefaultProvider:      "openai",
			DefaultThinkingLevel: "medium",
		},
	}
}

func TestEnsurePiAgentRouterSkipsPutForUnchangedSelectionInAnyOrder(t *testing.T) {
	var putRequests int
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-suggestions":
			_ = json.NewEncoder(w).Encode(map[string]any{"suggestions": []map[string]any{{
				"id": "codex", "models": map[string][]string{"anthropic/claude-fable-5": {"high"}, "zai-org/GLM-5.3": {"high"}},
			}}})

		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []any{}})

		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			// Default router lists the same models as the picker defaults,
			// but in the opposite order.
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{{
				"id":                    "rtr_default",
				"name":                  "Default",
				"is_default":            true,
				"enabled_models":        []string{"zai-org/GLM-5.3", "anthropic/claude-fable-5"},
				"model_providers":       map[string]string{"anthropic/claude-fable-5": "anthropic", "zai-org/GLM-5.3": "fireworks"},
				"model_thinking_levels": map[string][]string{"anthropic/claude-fable-5": {"high"}, "zai-org/GLM-5.3": {"high"}},
			}}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
			writeAgentModelCatalog(t, w)
		case r.Method == http.MethodPut:
			putRequests++
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_default"})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	useTestAPIKey(t)
	t.Setenv("DARI_API_URL", server.URL)
	routerID, err := ensureAgentRouter(
		context.Background(),
		"pi",
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader("n\n\n"),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	if routerID != "rtr_default" {
		t.Fatalf("router ID = %q", routerID)
	}
	if putRequests != 0 {
		t.Fatalf("PUT requests = %d, want 0", putRequests)
	}
}

func TestPickerLevelOnlyChangeProducesUpdate(t *testing.T) {
	// The TUI is the only path that can change thinking levels without
	// changing the model set, so drive its state machine directly.
	models := testAgentModels()
	models[0].SupportedLevels = []string{"low", "high", "max"}
	current := agentRouter{
		EnabledModels:       []string{"anthropic/claude-fable-5"},
		ModelProviders:      map[string]string{"anthropic/claude-fable-5": "anthropic"},
		ModelThinkingLevels: map[string][]string{"anthropic/claude-fable-5": {"high"}},
	}
	p := newAgentPickerState(models, current.EnabledModels, current.ModelThinkingLevels, current.ModelThinkingLevels, nil)

	// Open Fable's levels: cursor on high (index 1). Move to max, check it,
	// move back to high, uncheck it, then leave editing.
	for _, key := range []string{"right", "down", " ", "up", " ", "left", "enter"} {
		if _, canceled := p.handleKey(key); canceled {
			t.Fatal("picker canceled")
		}
	}
	choices := p.choices()
	if len(choices) != 1 || choices[0].ID != "anthropic/claude-fable-5" {
		t.Fatalf("choices = %#v", choices)
	}
	if got := choices[0].Levels; !slices.Equal(got, []string{"max"}) {
		t.Fatalf("fable levels = %q, want [max]", got)
	}
	if !agentRouterNeedsUpdate(current, choices) {
		t.Fatal("level-only edit was ignored")
	}
	body := agentRouterUpdateBody(current, models, choices)
	if got := body.ModelThinkingLevels["anthropic/claude-fable-5"]; !slices.Equal(got, []string{"max"}) {
		t.Fatalf("update body levels = %q, want [max]", got)
	}
}

func TestAgentRouterNeedsUpdateIgnoresModelOrder(t *testing.T) {
	current := agentRouter{
		EnabledModels:       []string{"zai-org/GLM-5.3", "anthropic/claude-fable-5"},
		ModelThinkingLevels: map[string][]string{"anthropic/claude-fable-5": {"high"}, "zai-org/GLM-5.3": {"high"}},
	}
	choices := []agentModelChoice{
		{ID: "anthropic/claude-fable-5", Levels: []string{"high"}},
		{ID: "zai-org/GLM-5.3", Levels: []string{"high"}},
	}
	if agentRouterNeedsUpdate(current, choices) {
		t.Fatal("update triggered for the same models in a different order")
	}
}

func TestAgentPickerLinesAlignAndScroll(t *testing.T) {
	models := testAgentModels()
	models[0].DisplayName = "A Very Long Model Name Indeed"
	p := newAgentPickerState(models, []string{"anthropic/claude-fable-5"}, nil, testRecommendedLevels(), nil)
	p.handleKey("down")

	// The thinking column lines up across rows regardless of name length.
	levelCols := map[int]bool{}
	for _, line := range agentPickerLines("Choose models", []string{"note"}, p, len(models))[2 : len(models)+2] {
		plain := stripANSI(line)
		trimmed := strings.TrimRight(strings.TrimSuffix(plain, "recommended"), " ")
		levelCols[len([]rune(trimmed[:strings.LastIndex(trimmed, "  ")]))] = true
	}
	if len(levelCols) != 1 {
		t.Fatalf("level column positions = %v, want one", levelCols)
	}

	// Only the visible window renders, with counts for what is hidden.
	p.cursor = len(models) - 1
	plain := stripANSI(strings.Join(agentPickerLines("Choose models", []string{"note"}, p, 2), "\n"))
	if !strings.Contains(plain, fmt.Sprintf("↑ %d more", len(models)-2)) || strings.Count(plain, " more") != 1 {
		t.Fatalf("scrolled picker:\n%s", plain)
	}
}

func TestAgentTUIRenderDrawsPageFromTop(t *testing.T) {
	var out strings.Builder
	session := &agentTUISession{stderr: &out}
	session.render([]string{"one"})
	got := out.String()
	// Raw mode needs \r\n, and every row clears what an earlier page left.
	if !strings.HasPrefix(got, "\033[H") || !strings.HasSuffix(got, "  one"+ansiReset+"\033[K\r\n\033[J") || strings.Contains(strings.ReplaceAll(got, "\r\n", ""), "\n") {
		t.Fatalf("page = %q", got)
	}
	// The welcome box closes evenly.
	widths := map[int]bool{}
	for _, line := range agentPageHeader(0)[:4] {
		widths[ansiVisibleWidth(line)] = true
	}
	// On a wide page the box sits in the middle.
	top := agentPageHeader(100)[0]
	if lead := len(top) - len(strings.TrimLeft(top, " ")); lead != (100-ansiVisibleWidth(strings.TrimLeft(top, " ")))/2 {
		t.Fatalf("box indent = %d: %q", lead, top)
	}
	if len(widths) != 1 || !strings.Contains(stripANSI(got), "dari.dev") {
		t.Fatalf("header widths %v:\n%s", widths, stripANSI(got))
	}
}
func TestAgentPickerNeverSubmitsEmptyLevels(t *testing.T) {
	// A model with supported levels but no recommended set, no default
	// level, and no current router levels must still get a level.
	models := []agentModel{{
		ID:              "openai/gpt-5.6-terra",
		DisplayName:     "Terra",
		Provider:        "openai",
		DefaultProvider: "openai",
		SupportedLevels: []string{"low", "medium", "high"},
	}}
	p := newAgentPickerState(models, []string{"openai/gpt-5.6-terra"}, nil, nil, nil)
	if got := p.rows[0].checkedLevels(); !slices.Equal(got, []string{"low"}) {
		t.Fatalf("initial levels = %q, want first supported [low]", got)
	}

	// Emptying the level checklist and leaving restores a usable set too.
	p.handleKey("right")
	p.handleKey(" ") // uncheck low
	if got := p.rows[0].checkedLevels(); len(got) != 0 {
		t.Fatalf("levels = %q, want none", got)
	}
	p.handleKey("left")
	if got := p.rows[0].checkedLevels(); !slices.Equal(got, []string{"low"}) {
		t.Fatalf("levels after exit = %q, want fallback [low]", got)
	}

	done, canceled := p.handleKey("enter")
	if !done || canceled {
		t.Fatalf("enter = done %v canceled %v", done, canceled)
	}
	choices := p.choices()
	if len(choices) != 1 || len(choices[0].Levels) == 0 {
		t.Fatalf("choices = %#v, want one model with levels", choices)
	}
}

func stripANSI(s string) string {
	re := regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
	return re.ReplaceAllString(s, "")
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func TestEnsureClaudeAgentRouterIgnoresMatchingDefaultRouter(t *testing.T) {
	// Even when the org default router is customized to exactly Claude's
	// models with different levels, Claude onboarding must recommend its own
	// set with the catalog's recommended levels.
	var created map[string]any
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
			_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{{
				"id":         "rtr_default",
				"name":       "Default",
				"is_default": true,
				"enabled_models": []string{
					"anthropic/claude-fable-5",
					"anthropic/claude-opus-5",
					"zai-org/GLM-5.3-Flash",
				},
				"model_thinking_levels": map[string][]string{
					"anthropic/claude-fable-5": {"low"},
					"anthropic/claude-opus-5":  {"medium"},
					"zai-org/GLM-5.3-Flash":    {"medium"},
				},
			}}})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
			writeClaudeSubscriptionCredential(w)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
			writeAgentModelCatalog(t, w)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-suggestions":
			writeAgentModelSuggestions(t, w)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/routers":
			if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
				t.Error(err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_claude", "name": ownRouterName("claude", true)})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	useTestAPIKey(t)
	t.Setenv("DARI_API_URL", server.URL)
	routerID, err := ensureAgentRouter(
		context.Background(),
		"claude",
		agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
		strings.NewReader("\n"),
		io.Discard,
	)
	if err != nil {
		t.Fatal(err)
	}
	if routerID != "rtr_claude" {
		t.Fatalf("router ID = %q", routerID)
	}
	levels, _ := created["model_thinking_levels"].(map[string]any)
	for modelID, want := range map[string][]string{
		"anthropic/claude-fable-5-1": {"high"},
		"zai-org/GLM-5.3-Flash":      {"high"},
		"xai/grok-4.7":               {"high"},
		"openai/gpt-5.6-sol":         {"medium"},
	} {
		if got := stringSlice(levels[modelID]); !slices.Equal(got, want) {
			t.Errorf("%s levels = %q, want recommended %q", modelID, got, want)
		}
	}
}

func TestMuseCodeRouterServesThePlan(t *testing.T) {
	for _, tc := range []struct {
		name      string
		connected bool
		input     string
		wantError bool
	}{
		{name: "newly connected", connected: false, input: "y\n\n\n"},
		{name: "already connected", connected: true, input: "\n\n"},
		{name: "no Meta model selected", connected: true, input: "2\n", wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var created map[string]any
			connected := tc.connected
			server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers":
					_ = json.NewEncoder(w).Encode(map[string]any{"routers": []map[string]any{{
						"id": "rtr_default", "name": "Default", "is_default": true,
						"enabled_models": []string{"openai/gpt-5.6-sol"},
					}}})
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/credentials":
					credentials := []any{}
					if connected {
						credentials = append(credentials, map[string]any{"oauth_provider": museSubscription.id})
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"credentials": credentials})
				case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/credentials/oauth/sessions":
					_ = json.NewEncoder(w).Encode(agentSubscriptionOAuthStart{SessionToken: "session", AuthorizationURL: "https://auth.meta.com/oauth/device/", UserCode: "BLXG-CHNZ"})
				case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/credentials/oauth/sessions/complete":
					connected = true
					w.WriteHeader(http.StatusOK)
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-catalog":
					_ = json.NewEncoder(w).Encode(map[string]any{"groups": []map[string]any{{
						"provider":             "managed",
						"supports_managed_key": true,
						"models": []map[string]any{
							{"id": "meta/muse-spark", "display_name": "Muse Spark", "provider": "meta", "default_provider": "meta", "default_thinking_level": "high", "supports_managed_key": true},
							{"id": "openai/gpt-5.6-sol", "display_name": "Sol", "provider": "openai", "default_provider": "openai", "default_thinking_level": "medium", "supports_managed_key": true},
						},
					}}})
				case r.Method == http.MethodGet && r.URL.Path == "/v1/organizations/current/routers/model-suggestions":
					_ = json.NewEncoder(w).Encode(map[string]any{"suggestions": []map[string]any{{
						"id":        "muse",
						"model_ids": []string{"meta/muse-spark"},
						"models":    map[string]any{"meta/muse-spark": []string{"high"}},
					}}})
				case r.Method == http.MethodPost && r.URL.Path == "/v1/organizations/current/routers":
					if err := json.NewDecoder(r.Body).Decode(&created); err != nil {
						t.Error(err)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "rtr_muse"})
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			useTestAPIKey(t)
			t.Setenv("DARI_API_URL", server.URL)
			original := openAgentBrowser
			openAgentBrowser = func(string) bool { return false }
			t.Cleanup(func() { openAgentBrowser = original })
			routerID, err := ensureAgentRouter(
				context.Background(),
				"muse",
				agentRoutingAccess{apiURL: server.URL, scope: "test-org", key: "dari_route"},
				strings.NewReader(tc.input),
				io.Discard,
			)
			if tc.wantError {
				if err == nil || !strings.Contains(err.Error(), "served directly by Meta") {
					t.Fatalf("expected a Meta model selection error, got %v", err)
				}
				if created != nil {
					t.Fatalf("incomplete setup must not create a router: %#v", created)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if routerID != "rtr_muse" || created["client_key"] != "dari-cli:muse-code" || created["name"] != "Dari Muse Code" {
				t.Fatalf("router %q created as %v (%v)", routerID, created["name"], created["client_key"])
			}
			if got := stringSlice(created["subscription_providers"]); !slices.Equal(got, []string{"meta"}) {
				t.Fatalf("subscription_providers = %q, want [meta]", got)
			}
		})
	}
}

func TestAgentSessionPinningKeepsTheRoutersModeWithoutTerminal(t *testing.T) {
	for _, current := range []bool{false, true} {
		var stderr strings.Builder
		pinned, err := chooseAgentSessionPinning(strings.NewReader("1\n"), &stderr, current)
		if err != nil {
			t.Fatal(err)
		}
		if pinned != current || stderr.Len() != 0 {
			t.Errorf("current %v: pinned = %v, stderr = %q", current, pinned, stderr.String())
		}
	}
}

func TestAgentRouterUpdateKeepsTheRoutersSessionPinning(t *testing.T) {
	body := agentRouterUpdateBody(agentRouter{Name: "Default", SessionPinning: true}, nil, nil)
	encoded, _ := json.Marshal(body)
	if !strings.Contains(string(encoded), `"session_pinning":true`) {
		t.Errorf("payload drops session_pinning: %s", encoded)
	}
}

func TestSecretDisplayMasksTheKey(t *testing.T) {
	if got := secretDisplay("sk-secret", 80); strings.Contains(got, "sk-secret") || strings.Count(got, "•") != len("sk-secret") {
		t.Errorf("secretDisplay = %q", got)
	}
	if got := secretDisplay(strings.Repeat("x", 200), 40); strings.Count(got, "•") != 34 {
		t.Errorf("long secret shows %d bullets", strings.Count(got, "•"))
	}
}

func TestClaudeCodeRouterServesChatGPTAlongsideClaudeCode(t *testing.T) {
	models, choices := providerKeysTestModels()
	body := agentRouterCreateBody(agentSetups["claude"], models, choices, []agentSubscriptionProvider{claudeSubscription, codexSubscription})
	if body.Name != "Dari Claude Code" || body.ClientKey != "dari-cli:claude-code" {
		t.Errorf("router = %q (%q)", body.Name, body.ClientKey)
	}
	if want := []string{"anthropic", "openai"}; !slices.Equal(body.SubscriptionProviders, want) {
		t.Errorf("subscription_providers = %v, want %v", body.SubscriptionProviders, want)
	}
	managed := agentRouterCreateBody(agentSetups["codex"], models, choices, nil)
	if managed.Name != "Dari Codex (Managed)" || managed.ClientKey != "dari-cli:codex-managed" || len(managed.SubscriptionProviders) != 0 {
		t.Errorf("managed router = %q (%q) %v", managed.Name, managed.ClientKey, managed.SubscriptionProviders)
	}
}

func TestChatGPTForCodexDoesNotSetUpClaudeCode(t *testing.T) {
	server := newAgentTestServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"credentials": []map[string]any{
			{"oauth_provider": codexSubscription.id, "credential_scope": "user"},
		}})
	}))
	defer server.Close()

	for _, optedOut := range []bool{false, true} {
		var stderr strings.Builder
		resolution, err := resolveAgentPersonalSubscription(
			context.Background(),
			agentSubscriptionProviders("claude"),
			api.New(server.URL),
			strings.NewReader(""),
			&stderr,
			optedOut,
		)
		if err != nil {
			t.Fatal(err)
		}
		if resolution.enabled {
			t.Errorf("opted out %v: a ChatGPT account enabled Claude Code's subscription: %#v", optedOut, resolution)
		}
		if !optedOut && !strings.Contains(stderr.String(), "Use your Claude Code personal subscription?") {
			t.Errorf("stderr = %q, want the Claude Code question", stderr.String())
		}
	}
}

func TestAgentPickerPaymentFollowsTheProviderExceptGateways(t *testing.T) {
	native := func(kind, provider, label string) agentModelSource {
		return agentModelSource{kind: kind, provider: provider, modelProvider: provider, label: label}
	}
	vercel := agentModelSource{kind: "key", provider: "vercel-ai-gateway", modelProvider: "anthropic", credentialID: "cred_v", label: "Vercel AI Gateway key"}
	anthropic := []agentModelSource{native("subscription", "anthropic", "Claude Code subscription"), vercel, native("managed", "anthropic", "Dari credits")}
	models := []agentModel{{ID: "anthropic/opus", Provider: "anthropic"}, {ID: "anthropic/sonnet", Provider: "anthropic"}}
	p := newAgentPickerState(models, []string{"anthropic/opus", "anthropic/sonnet"}, nil, nil, map[string][]agentModelSource{
		"anthropic/opus": anthropic, "anthropic/sonnet": anthropic,
	})

	// A gateway key is per model.
	p.handleKey("s")
	if got := []string{p.rows[0].sources[p.rows[0].source].label, p.rows[1].sources[p.rows[1].source].label}; !slices.Equal(got, []string{"Vercel AI Gateway key", "Claude Code subscription"}) {
		t.Fatalf("after gateway: %q", got)
	}
	// Credits apply to the provider, so Sonnet follows Opus off the subscription.
	p.handleKey("s")
	choices := p.choices()
	if choices[0].Source.kind != "managed" || choices[1].Source.kind != "managed" {
		t.Fatalf("after credits: %+v", choices)
	}
}

func TestAgentPickerKeysIncludePaymentCycling(t *testing.T) {
	if got := parseAgentPickerKeys([]byte("\x1b[Bs\r")); !slices.Equal(got, []string{"down", "s", "enter"}) {
		t.Fatalf("keys = %q", got)
	}
}
