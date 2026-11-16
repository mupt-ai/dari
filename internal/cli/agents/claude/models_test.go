package claude

import (
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

var claudeRouter = []string{"anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5"}

func modelEnv(models agents.Models) map[string]string {
	return routingEnvironment("dak", "https://routing.dari.dev", "", false, models)
}

// Each alias names its own Claude model on every plan: `opus` is Opus, never
// whichever model the router lists first.
func TestAliasesNameTheirOwnModel(t *testing.T) {
	for _, tc := range []struct {
		name   string
		models agents.Models
		want   map[string]string
	}{
		{"without routing", agents.Models{Enabled: claudeRouter}, map[string]string{
			"ANTHROPIC_DEFAULT_OPUS_MODEL":   "dari/model/anthropic/claude-opus-5-5",
			"ANTHROPIC_DEFAULT_SONNET_MODEL": "dari/model/anthropic/claude-sonnet-5-5",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "dari/model/anthropic/claude-haiku-5-5",
			// Not enabled: requests fail with "not enabled", not a stand-in.
			"ANTHROPIC_DEFAULT_FABLE_MODEL": "dari/model/anthropic/claude-fable",
		}},
		{"with routing", agents.Models{Routing: true, Enabled: claudeRouter}, map[string]string{
			"ANTHROPIC_DEFAULT_OPUS_MODEL":   "dari/model/anthropic/claude-opus-5-5",
			"ANTHROPIC_DEFAULT_SONNET_MODEL": "dari/model/anthropic/claude-sonnet-5-5",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL":  "dari/model/anthropic/claude-haiku-5-5",
			"ANTHROPIC_DEFAULT_FABLE_MODEL":  "dari/model/anthropic/claude-fable",
		}},
		{"two versions take the router's first", agents.Models{Enabled: []string{"anthropic/claude-opus-5", "anthropic/claude-opus-5-5"}}, map[string]string{
			"ANTHROPIC_DEFAULT_OPUS_MODEL": "dari/model/anthropic/claude-opus-5",
		}},
		{"a chosen model awaiting an account still counts", agents.Models{Enabled: []string{"anthropic/claude-opus-5-5"}, Unavailable: []string{"anthropic/claude-sonnet-5-5"}}, map[string]string{
			"ANTHROPIC_DEFAULT_SONNET_MODEL": "dari/model/anthropic/claude-sonnet-5-5",
		}},
	} {
		env := modelEnv(tc.models)
		for name, want := range tc.want {
			if env[name] != want {
				t.Errorf("%s: %s = %q, want %q", tc.name, name, env[name], want)
			}
		}
	}
}

// With Dari Routing subagents are routed; without it Dari sets no subagent
// model, so a subagent that names none runs on the session's current model.
// The classifier always asks for dari/routing, which Dari serves as
// background work on the cheapest model, with or without the plan.
func TestSubagentAndClassifierModels(t *testing.T) {
	for _, tc := range []struct {
		name         string
		models       agents.Models
		wantSubagent string
	}{
		{"without routing", agents.Models{Enabled: claudeRouter}, ""},
		{"with routing", agents.Models{Routing: true, Enabled: claudeRouter}, agents.RoutingModel},
		{"no router resolved", agents.Models{}, agents.RoutingModel},
	} {
		env := modelEnv(tc.models)
		if env[subagentModelEnv] != tc.wantSubagent {
			t.Errorf("%s: %s = %q, want %q", tc.name, subagentModelEnv, env[subagentModelEnv], tc.wantSubagent)
		}
		if env[autoModeModelEnv] != agents.RoutingModel {
			t.Errorf("%s: %s = %q, want %q", tc.name, autoModeModelEnv, env[autoModeModelEnv], agents.RoutingModel)
		}
	}
}

// A launch keeps the user's Dari pick even while the router cannot serve it;
// anything else (nothing saved, a model from before Dari) starts on the default.
func TestStartModel(t *testing.T) {
	for _, tc := range []struct {
		name   string
		models agents.Models
		want   string
	}{
		{"nothing saved", agents.Models{Enabled: claudeRouter}, "dari/model/anthropic/claude-haiku-5-5"},
		{"an enabled pick", agents.Models{Enabled: claudeRouter, Saved: "dari/model/anthropic/claude-opus-5-5"}, "dari/model/anthropic/claude-opus-5-5"},
		{"routing without the plan", agents.Models{Enabled: claudeRouter, Saved: agents.RoutingModel}, agents.RoutingModel},
		{"a disabled model", agents.Models{Enabled: claudeRouter, Saved: "dari/model/anthropic/claude-fable-5-2"}, "dari/model/anthropic/claude-fable-5-2"},
		{"a model from before Dari", agents.Models{Enabled: claudeRouter, Saved: "claude-opus-5-5"}, "dari/model/anthropic/claude-haiku-5-5"},
		{"nothing saved with routing", agents.Models{Routing: true, Enabled: claudeRouter}, agents.RoutingModel},
	} {
		if got := StartModel(tc.models); got != tc.want {
			t.Errorf("%s: StartModel = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestWarnings(t *testing.T) {
	missingFable := "Not enabled on this router: fable. Claude Code requests for them (such as a subagent's model) fail."
	for _, tc := range []struct {
		name   string
		models agents.Models
		hosted bool
		want   []string
	}{
		{"nothing to say", agents.Models{Enabled: append(slices.Clone(claudeRouter), "anthropic/claude-fable-5-2"), Saved: "dari/model/anthropic/claude-opus-5-5"}, true, nil},
		{"a family missing", agents.Models{Enabled: claudeRouter}, true, []string{missingFable}},
		{"routing pick without the plan", agents.Models{Enabled: claudeRouter, Saved: agents.RoutingModel}, true, []string{
			"Your saved model dari/routing is not available: it needs the Autorouting plan; run `dari accounts` to get it. Its requests fail until you pick another with /model.",
			missingFable,
		}},
		// A gateway serves dari/routing even without auto-routing.
		{"routing pick on a gateway", agents.Models{Enabled: claudeRouter, Saved: agents.RoutingModel}, false, []string{missingFable}},
		{"a disabled pick", agents.Models{Enabled: claudeRouter, Saved: "dari/model/anthropic/claude-fable-5-2"}, true, []string{
			"Your saved model dari/model/anthropic/claude-fable-5-2 is not available: it is not enabled on this router. Its requests fail until you pick another with /model.",
			missingFable,
		}},
		{"a pick awaiting an account", agents.Models{Enabled: claudeRouter, Unavailable: []string{"anthropic/claude-fable-5-2"}, Saved: "dari/model/anthropic/claude-fable-5-2"}, false, []string{
			"Your saved model dari/model/anthropic/claude-fable-5-2 is not available: no connected account or API key serves it yet. Its requests fail until you pick another with /model.",
		}},
		{"a model from before Dari", agents.Models{Enabled: append(slices.Clone(claudeRouter), "anthropic/claude-fable-5-2"), Saved: "opus"}, true, nil},
	} {
		if got := Warnings(tc.models, tc.hosted); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: Warnings =\n%q\nwant\n%q", tc.name, got, tc.want)
		}
	}
}

// A launch without routing drops a subagent pin it inherits, such as one a
// parent Claude Code session exported, and starts on the saved pick.
func TestConfigureWithoutRouting(t *testing.T) {
	saved := agents.RoutingModel
	command := agents.Command{Path: "/claude", Env: []string{subagentModelEnv + "=dari/model/anthropic/claude-haiku-5-5", "KEEP=1"}}
	if err := Configure(&command, "dak", "https://routing.dari.dev", agents.Models{Enabled: claudeRouter, Saved: saved}); err != nil {
		t.Fatal(err)
	}
	if got := agents.EnvironmentValue(command.Env, subagentModelEnv); got != "" || slices.ContainsFunc(command.Env, func(e string) bool { return strings.HasPrefix(e, subagentModelEnv+"=") }) {
		t.Fatalf("env keeps %s=%q", subagentModelEnv, got)
	}
	if agents.EnvironmentValue(command.Env, "KEEP") != "1" {
		t.Fatal("unrelated env dropped")
	}
	if i := slices.Index(command.Args, "--model"); i < 0 || command.Args[i+1] != saved {
		t.Fatalf("args = %q, want --model %s", command.Args, saved)
	}
}

// Setup on a router without routing removes the subagent pin an earlier setup
// wrote and keeps the saved pick through a lapse in the Autorouting plan, so
// routing comes back with the plan. Removal restores the user's own values.
func TestCLISetupThroughAPlanLapse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	writeSettings(t, path, `{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"opus"}}`)
	setup := func(models agents.Models) (string, any) {
		t.Helper()
		models.Saved = SavedModel(path)
		if _, err := CLISetup(path, "", "https://routing.dari.dev", "dak", models); err != nil {
			t.Fatal(err)
		}
		settings, _ := readJSON(path)
		model, _ := settings["model"].(string)
		return model, settings["env"].(map[string]any)[subagentModelEnv]
	}

	// On the plan, nothing saved: routing for the session and its subagents.
	if model, subagent := setup(agents.Models{Routing: true, Enabled: claudeRouter}); model != agents.RoutingModel || subagent != agents.RoutingModel {
		t.Fatalf("with the plan: model %q, subagent %v", model, subagent)
	}
	// The plan lapses: the pin goes, the pick stays (its requests fail with the reason).
	if model, subagent := setup(agents.Models{Enabled: claudeRouter}); model != agents.RoutingModel || subagent != nil {
		t.Fatalf("after the lapse: model %q, subagent %v", model, subagent)
	}
	// The plan returns: routing again, not a stand-in left behind.
	if model, subagent := setup(agents.Models{Routing: true, Enabled: claudeRouter}); model != agents.RoutingModel || subagent != agents.RoutingModel {
		t.Fatalf("with the plan again: model %q, subagent %v", model, subagent)
	}
	setup(agents.Models{Enabled: claudeRouter})
	if _, err := RemoveCLISetup(path); err != nil {
		t.Fatal(err)
	}
	settings, _ := readJSON(path)
	if got := settings["env"].(map[string]any)[subagentModelEnv]; got != "opus" {
		t.Fatalf("after removal %s = %v, want the user's own", subagentModelEnv, got)
	}
}
