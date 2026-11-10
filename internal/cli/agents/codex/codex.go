// Package codex launches Codex through Dari. Interactive launches get a
// session-local bridge that shows routing status in Codex's footer.
package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/mupt-ai/dari/internal/cli/agents"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

// Configure selects the launch's default model through Codex config overrides
// that point at the router at baseURL, leaving the user's Codex config untouched.
func Configure(command *agents.Command, baseURL string, models agents.Models) {
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{
		"--config", "model=" + strconv.Quote(models.Default()),
		"--config", `model_provider="dari"`,
		"--config", `model_reasoning_summary="none"`,
		"--config", `model_providers.dari.name="Dari"`,
		"--config", `model_providers.dari.base_url="` + baseURL + `/v1"`,
		"--config", `model_providers.dari.env_key="DARI_ROUTING_API_KEY"`,
		"--config", `model_providers.dari.wire_api="responses"`,
	})
}

// Codex does not discover remote catalogs for env-key custom providers. Supply
// the authenticated router catalog explicitly so auxiliary agents do not pick
// bundled OpenAI models that the routing endpoint cannot serve. The catalog's
// models fill Codex's /model menu; dari/routing is dropped without the plan.
func PrepareCatalog(ctx context.Context, command *agents.Command, key, baseURL string, models agents.Models) error {
	body, disableWebSearch, err := Catalog(ctx, key, baseURL, models)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp("", "dari-codex-models-*.json")
	if err != nil {
		return fmt.Errorf("create Codex model catalog: %w", err)
	}
	path := file.Name()
	if _, err := file.Write(body); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return fmt.Errorf("write Codex model catalog: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("close Codex model catalog: %w", err)
	}
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--config", "model_catalog_json=" + strconv.Quote(path)})
	if disableWebSearch {
		command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--config", `web_search="disabled"`})
	}
	command.Cleanup = func() { _ = os.Remove(path) }
	return nil
}

// Catalog fetches the router's Codex model catalog, narrowed to the models
// menu, and reports whether the default model needs web search disabled.
func Catalog(ctx context.Context, key, baseURL string, models agents.Models) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/models", nil)
	if err != nil {
		return nil, false, fmt.Errorf("create Codex catalog request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("fetch Codex model catalog: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("fetch Codex model catalog: HTTP %d", resp.StatusCode)
	}
	const maxCatalogBytes = 4 << 20
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxCatalogBytes+1))
	if err != nil {
		return nil, false, fmt.Errorf("read Codex model catalog: %w", err)
	}
	if len(body) > maxCatalogBytes {
		return nil, false, fmt.Errorf("Codex model catalog exceeds size limit")
	}
	var catalog struct {
		Models []map[string]json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(body, &catalog); err != nil {
		return nil, false, fmt.Errorf("decode Codex model catalog: %w", err)
	}
	offered := map[string]bool{}
	for _, model := range models.Menu() {
		offered[model] = true
	}
	defaultModel := models.Default()
	found := false
	disableWebSearch := false
	kept := catalog.Models[:0]
	for _, model := range catalog.Models {
		var slug string
		if json.Unmarshal(model["slug"], &slug) != nil || !offered[slug] {
			continue
		}
		// Older servers use null to indicate unavailable web search. Codex
		// requires a concrete web-search enum, so disable the tool separately.
		if slug == defaultModel && string(model["web_search_tool_type"]) == "null" {
			disableWebSearch = true
		}
		if string(model["web_search_tool_type"]) == "null" {
			model["web_search_tool_type"] = json.RawMessage(`"text"`)
		}
		for _, field := range []string{"tool_mode", "multi_agent_version"} {
			if string(model[field]) == "null" {
				delete(model, field)
			}
		}
		// Also works against servers deployed before the reviewer override.
		model["auto_review_model_override"] = json.RawMessage(strconv.Quote(slug))
		found = found || slug == defaultModel
		kept = append(kept, model)
	}
	catalog.Models = kept
	if !found {
		return nil, false, fmt.Errorf("Codex model catalog is missing %s", defaultModel)
	}
	body, err = json.Marshal(catalog)
	if err != nil {
		return nil, false, fmt.Errorf("encode Codex model catalog: %w", err)
	}
	return body, disableWebSearch, nil
}
