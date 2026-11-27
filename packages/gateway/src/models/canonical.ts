import canonicalModels from "./canonical_models.json" with { type: "json" };
import providerModels from "./provider_models.json" with { type: "json" };

export type CanonicalModel = {
  id: string;
  name: string;
  // Who made it, which model pickers group by: "Moonshot AI", not the
  // provider serving it.
  maker: string;
  // The default provider's accepted thinking levels.
  thinking_levels: string[];
};

/** The canonical models Dari serves, from the monorepo's router catalog. */
export const CANONICAL_MODELS: readonly CanonicalModel[] = canonicalModels;

/** A model's catalog name; a model the catalog does not list keeps its id. */
export function canonicalModelName(id: string): string {
  return CANONICAL_MODELS.find((model) => model.id === id)?.name ?? id;
}

/** A canonical model as a provider other than the one its id names serves it. */
export type ProviderModel = {
  model_id: string;
  provider: string;
  native_model_id: string;
  api: string;
  base_url: string | null;
};

const PROVIDER_MODELS: readonly ProviderModel[] = providerModels;

/** How `provider` serves a model whose id names another provider, if it does. */
export function providerModel(modelId: string, provider: string): ProviderModel | undefined {
  return PROVIDER_MODELS.find((row) => row.model_id === modelId && row.provider === provider);
}

/** The providers besides the one its id names that serve a model. */
export function otherModelProviders(modelId: string): string[] {
  return PROVIDER_MODELS.filter((row) => row.model_id === modelId).map((row) => row.provider);
}
