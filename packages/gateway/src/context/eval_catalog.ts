import type { PublicEvalCatalogCard } from "../types.js";
import type { RouterEval } from "@mupt-ai/dari-router/policy-engine";

// Convert public cards into hidden ratio-calibration inputs. Cards without a
// sync timestamp or scores carry no signal and are dropped.
export function publicCatalogSelectorEvals(
  catalog: PublicEvalCatalogCard[] | null | undefined,
): RouterEval[] {
  if (!catalog) return [];
  return catalog.filter((card) => card.updated_at !== null && card.scores.length > 0);
}
