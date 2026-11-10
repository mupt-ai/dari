import { getBuiltinModels, getBuiltinProviders } from "@mupt-ai/pi-ai/providers/all";
import { HttpError } from "../http/errors.js";
import type { InteractionRequest } from "../interaction/types.js";
import { explicitModelId } from "../protocol/input/router_model.js";
import type { ResolvedRouter } from "../types.js";
import { modelNotEnabled, strictModelRequired } from "./explicit_model.js";

// Resolve only the requested catalog model, never turn a provider grant into
// selector candidates. Unknown IDs fail closed; a grant-only router has no
// candidates to route among, so it refuses them here with the strict errors.
export function strictProviderAccess(
  credentials: ResolvedRouter,
  interaction: InteractionRequest,
): { credentials: ResolvedRouter; interaction: InteractionRequest } {
  const providers = credentials.strict_providers;
  if (credentials.strict !== true || !providers?.length) return { credentials, interaction };
  const requested = explicitModelId(interaction.model);
  const grantOnly = credentials.enabled_models.length === 0;
  if (requested === null) {
    if (grantOnly) throw strictModelRequired();
    return { credentials, interaction };
  }
  const matches = new Set<string>();
  for (const provider of providers) {
    if (!(getBuiltinProviders() as readonly string[]).includes(provider)) {
      throw new HttpError(400, `Unknown strict provider '${provider}'.`, "unknown_provider");
    }
    for (const model of getBuiltinModels(provider as never)) {
      const id = `${provider}/${model.id}`;
      if (requested === id) matches.add(id);
    }
  }
  const model = [...matches][0];
  if (model === undefined) {
    if (grantOnly) throw modelNotEnabled(requested);
    return { credentials, interaction };
  }
  return {
    credentials: { ...credentials, enabled_models: [...new Set([...credentials.enabled_models, model])] },
    interaction: { ...interaction, model: `dari/model/${model}` },
  };
}
