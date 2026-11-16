import type { InteractionRequest } from "../interaction/types.js";
import { linkGrantError, modelNotServed } from "./errors.js";
import { CANONICAL_MODELS } from "../models/canonical.js";
import { explicitModelId, explicitModelSlug } from "../protocol/input/router_model.js";
import { modelMetadataLookup } from "../providers/pi.js";
import type { ResolvedRouter } from "../types.js";

/* A Dari Link token is served exactly what its request names, never a
   substitute. `dari/routing` chooses among the router's models the grant
   serves. A named model (`dari/model/<id>`; the ingress names every other
   model a link token asks for this way, see `linkTokenModel`) is the catalog
   model it names, by its full id, its bare id, or a dated snapshot of it. It
   is served as that model when a granted plan serves it, at any level the
   model supports, with the client's own thinking settings and no level chosen
   for it; otherwise the request fails with the reason. A grant with an API
   key for a gateway (OpenRouter, Vercel AI Gateway) is also served any model
   of that gateway by its full id, `openrouter/<id>`, which no catalog lists. A
   child token serves only its models, each at its pinned thinking level when
   it has one. */
export function linkGrantAccess(
  credentials: ResolvedRouter,
  interaction: InteractionRequest,
): { credentials: ResolvedRouter; interaction: InteractionRequest } {
  if (!credentials.link_grant_id) return { credentials, interaction };
  const pins = credentials.link_pins ?? null;
  const name = explicitModelId(interaction.model);
  // The grant's own models first; a catalog model it does not serve still
  // names the reason it cannot.
  // A gateway's model is named by its full id, which starts with the gateway.
  const gateway = name?.toLowerCase().split("/")[0];
  const viaGateway = gateway !== undefined && credentials.link_key_gateways !== undefined && Object.hasOwn(credentials.link_key_gateways, gateway);
  const named = name === null
    ? null
    : catalogModelFor(name, credentials.link_models ?? [])
      ?? catalogModelFor(name, CANONICAL_MODELS.map((model) => model.id))
      ?? (viaGateway ? name.toLowerCase() : null);
  if (name !== null && named === null) {
    throw linkGrantError(
      "model_not_granted",
      `Model '${name}' is not a catalog model this Dari Link grant can use. GET /v1/link/grant lists them.`,
    );
  }
  const pin = pins === null ? null : pins.find((candidate) => candidate.model === named) ?? null;
  if (pins !== null && pin === null) {
    throw linkGrantError(
      "model_not_granted",
      `This Dari Link child token serves only ${pins.map((candidate) => `'${explicitModelSlug(candidate.model)}'`).join(", ")}.`,
    );
  }
  if (named === null) {
    if (credentials.enabled_models.length > 0) return { credentials, interaction };
    throw linkGrantError(
      "model_not_granted",
      "No subscription this Dari Link grant may use serves a model its router lists. Name one of the grant's models as 'dari/model/<id>'; GET /v1/link/grant lists them.",
    );
  }
  if (!credentials.link_models?.includes(named) && !viaGateway) throw modelNotServed(credentials, named);
  // The router's own choice of thinking levels narrows only what it routes.
  const { [named]: _routed, ...thinkingLevels } = credentials.model_thinking_levels ?? {};
  const endpoint = viaGateway ? credentials.link_key_gateways![gateway!] : null;
  return {
    credentials: {
      ...credentials,
      enabled_models: [...new Set([...credentials.enabled_models, named])],
      model_thinking_levels: thinkingLevels,
      // A gateway the platform points elsewhere is called there.
      ...(endpoint == null
        ? {}
        : {
            model_configs: {
              ...credentials.model_configs,
              [named]: { provider: gateway!, native_model_id: named.slice(gateway!.length + 1), ...endpoint, cost: { input: 0, output: 0 } },
            },
          }),
    },
    interaction: {
      ...interaction,
      model: explicitModelSlug(named),
      reasoning: pin?.thinking
        ? { effort: pin.thinking, enabled: pin.thinking !== "off", clientOnly: true }
        : clientReasoning(credentials, named, interaction.reasoning),
    },
  };
}

// The client's own thinking settings. Anthropic takes `thinking: disabled` on
// every model, so a model with no "off" level is still served it exactly
// rather than refused.
function clientReasoning(
  credentials: ResolvedRouter,
  model: string,
  reasoning: InteractionRequest["reasoning"],
): NonNullable<InteractionRequest["reasoning"]> {
  if (reasoning?.enabled === false && reasoning.effort === "off") {
    const metadata = modelMetadataLookup(credentials.model_configs)(model);
    if (metadata.model.api === "anthropic-messages" && !metadata.supportedThinkingLevels.includes("off")) {
      return { enabled: false, clientOnly: true };
    }
  }
  return { ...reasoning, clientOnly: true };
}

// A snapshot date: Anthropic's `-20251001`, OpenAI's `-2025-08-07`.
const SNAPSHOT_DATE = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/* The model id in `models` a name means: the id itself, the one id it is the
   bare form of (`claude-haiku-4-5` is `anthropic/claude-haiku-4-5`), or either
   of those for a dated snapshot of it. A name two models share means neither. */
export function catalogModelFor(name: string, models: readonly string[]): string | null {
  for (const candidate of new Set([name.toLowerCase(), name.toLowerCase().replace(SNAPSHOT_DATE, "")])) {
    if (models.includes(candidate)) return candidate;
    const matches = models.filter((id) => id.endsWith(`/${candidate}`));
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}
