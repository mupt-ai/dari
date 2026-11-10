import type { ResolvedRouterModelConfig } from "../types.js";

export function effectiveContextWindow(config: ResolvedRouterModelConfig | undefined, allowLongContext = false): number | null {
  const window = config?.context_window;
  const limit = config?.standard_context_limit;
  if (allowLongContext || limit == null) return window ?? null;
  return Math.min(window ?? limit, limit);
}
