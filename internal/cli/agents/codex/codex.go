// Package codex launches Codex through Dari. Interactive launches get a
// session-local bridge that shows routing status in Codex's footer.
package codex

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// Configure selects the launch's default model through Codex config overrides
// that point at the router at baseURL, leaving the user's Codex config untouched.
func Configure(command *agents.Command, baseURL string, models agents.Models) {
	args := []string{
		"--config", "model=" + strconv.Quote(models.Default()),
		"--config", `model_provider="dari"`,
		"--config", `model_reasoning_summary="none"`,
		"--config", `model_providers.dari.name="Dari"`,
		"--config", `model_providers.dari.base_url="` + baseURL + `/v1"`,
		"--config", `model_providers.dari.env_key="DARI_ROUTING_API_KEY"`,
		"--config", `model_providers.dari.wire_api="responses"`,
	}
	// Always explicit, so a stale `dari setup` config.toml cannot keep it on.
	remoteCompaction := "unsupported"
	if models.RemoteCompaction {
		remoteCompaction = "v2"
	}
	args = append(args, "--config", `model_providers.dari.capabilities.remote_compaction="`+remoteCompaction+`"`)
	command.Args = agents.InsertBeforeDoubleDash(command.Args, args)
}

// PrepareCatalog hands this launch the router's model catalog through a config
// override, leaving the user's Codex config untouched. The file is named for
// its content, so concurrent launches on different routers never share one and
// the launcher has nothing to clean up.
func PrepareCatalog(ctx context.Context, command *agents.Command, key, baseURL string, models agents.Models) error {
	body, disableWebSearch, err := Catalog(ctx, key, baseURL, models)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(body)
	path, err := agents.WriteCacheFile("codex/models-"+hex.EncodeToString(digest[:8])+".json", string(body))
	if err != nil {
		return fmt.Errorf("write Codex model catalog: %w", err)
	}
	args := []string{"--config", "model_catalog_json=" + strconv.Quote(path)}
	if disableWebSearch {
		args = append(args, "--config", `web_search="disabled"`)
	}
	command.Args = agents.InsertBeforeDoubleDash(command.Args, args)
	return nil
}

// Catalog fetches the router's Codex model catalog, narrowed to the models
// menu, and reports whether the default model needs web search disabled.
// Launches and setup hand it to Codex: Codex does not discover remote catalogs
// for custom providers, so the authenticated router catalog is supplied
// explicitly, and auxiliary agents never pick bundled OpenAI models the
// routing endpoint cannot serve. Its models fill Codex's /model menu;
// dari/routing is dropped without the plan.
func Catalog(ctx context.Context, key, baseURL string, models agents.Models) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/models", nil)
	if err != nil {
		return nil, false, fmt.Errorf("create Codex catalog request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	// The catalog must hold the models a gateway lists for Codex.
	req.Header.Set(agents.ClientHarnessHeader, "codex")
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

// LiveCatalogURL is the router's model list, for Codex to read itself, or ""
// when the router cannot serve Codex one (an older gateway) or Codex would
// refuse the URL. Codex re-reads the URL while it runs, on a timer and when a
// response says the list changed, so a setup that names it follows the
// router's models instead of the copy it wrote. Without one, setup writes that
// copy, as before.
func LiveCatalogURL(ctx context.Context, key, baseURL, defaultModel string) (string, error) {
	catalogURL := baseURL + "/v1/models"
	if !codexAcceptsCatalogURL(catalogURL) {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// Ask as Codex does: it names its version in the query.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, catalogURL+"?client_version=dari-setup", nil)
	if err != nil {
		return "", fmt.Errorf("create Codex catalog request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch Codex model catalog: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch Codex model catalog: HTTP %d", resp.StatusCode)
	}
	var catalog struct {
		Direct bool `json:"codex_direct"`
		Models []struct {
			Slug string `json:"slug"`
		} `json:"models"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&catalog); err != nil || !catalog.Direct {
		return "", nil
	}
	for _, model := range catalog.Models {
		if model.Slug == defaultModel {
			return catalogURL, nil
		}
	}
	return "", nil
}

// codexAcceptsCatalogURL follows Codex's rule for a model_catalog_url: HTTPS,
// or HTTP to this machine, with no user info or fragment. Codex will not
// start with one it refuses.
func codexAcceptsCatalogURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); ip != nil {
		return u.Scheme == "http" && ip.IsLoopback()
	}
	return u.Scheme == "http" && strings.EqualFold(host, "localhost")
}
