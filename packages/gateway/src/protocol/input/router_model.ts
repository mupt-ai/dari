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
   provider-prefixed (`anthropic/claude-opus-5`) forms. */
const ANTHROPIC_MODEL_ID_PATTERN = /^(anthropic\/)?claude-[a-z0-9][a-z0-9.-]*$/i;

export function isAnthropicRouterModel(model: string): boolean {
  return ANTHROPIC_ROUTER_MODELS.has(model) || ANTHROPIC_MODEL_ID_PATTERN.test(model);
}

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

const UNSUPPORTED_MODEL_MESSAGE =
  `Only model '${CANONICAL_ROUTER_MODEL}' or '${EXPLICIT_MODEL_PREFIX}<model>' is supported.`;

export function unsupportedModelMessage(): string {
  return UNSUPPORTED_MODEL_MESSAGE;
}
