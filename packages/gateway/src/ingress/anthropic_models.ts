/* Anthropic-compatible model discovery. Claude Desktop, Cowork, and other
   Anthropic-SDK gateway clients list models before first use and parse the
   Anthropic list shape ({data: [{type: "model", ...}]}), not the Codex
   catalog shape. Discovery advertises the tier synonyms from router_model.ts —
   the only ids such clients accept as usable (verified in-app: `dari/routing`
   is rejected, bare tier names classify). Fixed created_at keeps the response
   byte-stable. */

import { ANTHROPIC_ROUTER_MODEL_TIERS } from "../protocol/input/router_model.js";

const ROUTER_MODEL_CREATED_AT = "2026-01-01T00:00:00Z";

const tierLabel = (tier: string) =>
  `Dari Routing (${tier[0].toUpperCase()}${tier.slice(1)} tier)`;

export function anthropicModelsResponse(): Record<string, unknown> {
  return {
    data: ANTHROPIC_ROUTER_MODEL_TIERS.map((tier) => ({
      type: "model",
      id: tier,
      display_name: tierLabel(tier),
      created_at: ROUTER_MODEL_CREATED_AT,
    })),
    first_id: ANTHROPIC_ROUTER_MODEL_TIERS[0],
    last_id: ANTHROPIC_ROUTER_MODEL_TIERS[ANTHROPIC_ROUTER_MODEL_TIERS.length - 1],
    has_more: false,
  };
}
