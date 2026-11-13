import canonicalModels from "./canonical_models.json" with { type: "json" };

export type CanonicalModel = {
  id: string;
  name: string;
  // The default provider's accepted thinking levels.
  thinking_levels: string[];
};

/** The canonical models Dari serves, from the monorepo's router catalog. */
export const CANONICAL_MODELS: readonly CanonicalModel[] = canonicalModels;

/** A model's catalog name; a model the catalog does not list keeps its id. */
export function canonicalModelName(id: string): string {
  return CANONICAL_MODELS.find((model) => model.id === id)?.name ?? id;
}
