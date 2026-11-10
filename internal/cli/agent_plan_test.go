package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

func TestRouterModelsFollowTheRoutersCatalog(t *testing.T) {
	for _, tc := range []struct {
		name  string
		slugs []string
		want  agents.Models
	}{
		{"autorouting", []string{"dari/routing", "dari/model/openai/gpt-5.6-sol", "dari/model/anthropic/claude-opus-5"}, agents.Models{Routing: true, Enabled: []string{"openai/gpt-5.6-sol", "anthropic/claude-opus-5"}}},
		{"no autorouting", []string{"dari/model/openai/gpt-5.6-sol", "dari/model/anthropic/claude-opus-5"}, agents.Models{Enabled: []string{"openai/gpt-5.6-sol", "anthropic/claude-opus-5"}}},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/rtr_1/v1/models" || r.Header.Get("Authorization") != "Bearer dak_routing" {
				t.Fatalf("unexpected request %s with %q", r.URL.Path, r.Header.Get("Authorization"))
			}
			models := []map[string]string{}
			for _, slug := range tc.slugs {
				models = append(models, map[string]string{"slug": slug})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"models": models})
		}))
		got, err := routerModels(t.Context(), server.URL+"/rtr_1", "dak_routing")
		server.Close()
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: models = %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func TestModelsDefaultAndMenu(t *testing.T) {
	routing := agents.Models{Routing: true, Enabled: []string{"a/b"}}
	if routing.Default() != "dari/routing" || !reflect.DeepEqual(routing.Menu(), []string{"dari/routing", "dari/model/a/b"}) {
		t.Errorf("routing: %s %v", routing.Default(), routing.Menu())
	}
	explicit := agents.Models{Enabled: []string{"a/b", "c/d"}}
	if explicit.Default() != "dari/model/a/b" || !reflect.DeepEqual(explicit.Menu(), []string{"dari/model/a/b", "dari/model/c/d"}) {
		t.Errorf("explicit: %s %v", explicit.Default(), explicit.Menu())
	}
	if (agents.Models{}).Default() != "dari/routing" {
		t.Error("unresolved router should keep dari/routing")
	}
}
