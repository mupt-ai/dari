/* The router exposes one logical model, `dari/routing`. Some client protocols
   need protocol-specific synonyms for it; each synonym set lives here beside
   the canonical id, scoped by protocol, so a future set for another protocol
   (e.g. Codex) slots in alongside rather than widening a shared one.

   Anthropic: Claude Desktop / Cowork only mark a discovered model "usable"
   when its id maps to a Claude family tier, so the Anthropic-facing surfaces
   accept bare tier names. The alias carries no routing meaning — the selector
   decides the executed model — it only keeps every tier a harness can emit
   (fable main threads, opus subagents, haiku background work) funneling into
   the router instead of leaking to a direct provider call. */

export const CANONICAL_ROUTER_MODEL = "dari/routing";

/* Full anthropicFamilyTier enum per Anthropic's third-party gateway docs,
   ordered most to least capable; discovery advertises them in this order. */
export const ANTHROPIC_ROUTER_MODEL_TIERS = ["mythos", "opus", "fable", "sonnet", "haiku"] as const;

const ANTHROPIC_ROUTER_MODELS = new Set<string>([CANONICAL_ROUTER_MODEL, ...ANTHROPIC_ROUTER_MODEL_TIERS]);

/* Claude Code's subagent bootstrap resolves tiers to concrete ids before the
   request leaves the client (wire-captured live: Task spawns emit
   `claude-opus-5` even when the session model is dari/routing), so concrete
   Claude-family ids are synonyms too — both bare (`claude-opus-5`) and
   provider-prefixed (`anthropic/claude-opus-5`) forms. `dari claude --setup-desktop`
   relies on this: the Claude app lists routing as `claude-dari-routing`. */
const ANTHROPIC_MODEL_ID_PATTERN = /^(anthropic\/)?claude-[a-z0-9][a-z0-9.-]*$/i;

export function isAnthropicRouterModel(model: string): boolean {
  return ANTHROPIC_ROUTER_MODELS.has(model) || ANTHROPIC_MODEL_ID_PATTERN.test(model);
}

// The name the Claude app lists routing under; it names no model.
const CLAUDE_APP_ROUTER_MODEL = "claude-dari-routing";

/* An explicit model, `dari/model/<catalog id>`, serves exactly that enabled
   model without selection, so a client's model picker can switch models. It
   is a separate namespace so the synonyms above, which Claude Code subagents
   emit, keep routing. */
export const EXPLICIT_MODEL_PREFIX = "dari/model/";

export function explicitModelId(model: string | undefined): string | null {
  if (!model?.startsWith(EXPLICIT_MODEL_PREFIX)) return null;
  const id = model.slice(EXPLICIT_MODEL_PREFIX.length);
  return id.length > 0 ? id : null;
}

export function explicitModelSlug(modelId: string): string {
  return EXPLICIT_MODEL_PREFIX + modelId;
}

// A Dari Link token's access, child, and endpoint key tokens, which every
// platform issues.
export const LINK_ACCESS_TOKEN_PREFIX = "dlk_at_";
export const LINK_CHILD_TOKEN_PREFIX = "dlk_ct_";
export const LINK_KEY_TOKEN_PREFIX = "dlk_key_";

export function isLinkToken(token: string): boolean {
  return token.startsWith(LINK_ACCESS_TOKEN_PREFIX)
    || token.startsWith(LINK_CHILD_TOKEN_PREFIX)
    || token.startsWith(LINK_KEY_TOKEN_PREFIX);
}

/* A Dari Link token is served exactly the model it names, so every name but
   the router's own (`dari/routing`, the Anthropic tier names, the Claude app's
   routing name) names a catalog model: `gpt-5.5`, `claude-sonnet-5-5`,
   `anthropic/claude-sonnet-5-5`, or a dated snapshot such as
   `claude-haiku-4-5-20251001`. It is taken as `dari/model/<name>`, which the
   grant resolves to the catalog model it serves, so an app forwarding Claude
   Code or Codex traffic needs no model map, and the client's thinking settings
   for that model are kept. Any other key is unchanged. */
export function linkTokenModel<T>(token: string, model: T): T | string {
  if (!isLinkToken(token) || typeof model !== "string" || model.length === 0) return model;
  if (
    model === CANONICAL_ROUTER_MODEL
    || model.toLowerCase() === CLAUDE_APP_ROUTER_MODEL
    || explicitModelId(model) !== null
    || (ANTHROPIC_ROUTER_MODEL_TIERS as readonly string[]).includes(model)
  ) {
    return model;
  }
  return explicitModelSlug(model);
}

// Bare catalog ids such as `gpt-5.5` are not model names here: name one as
// `dari/model/<provider>/<model>`, which GET /v1/models lists.
const UNSUPPORTED_MODEL_MESSAGE =
  `Only model '${CANONICAL_ROUTER_MODEL}' or '${EXPLICIT_MODEL_PREFIX}<model>' is supported.`
  + ` Name a catalog model as '${EXPLICIT_MODEL_PREFIX}<provider>/<model>', such as '${EXPLICIT_MODEL_PREFIX}openai/gpt-5.5'; GET /v1/models lists them.`;

export function unsupportedModelMessage(): string {
  return UNSUPPORTED_MODEL_MESSAGE;
}
