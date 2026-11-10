import type { ReasoningEffort } from "./types.js";

// One observation is one model on one eval, already normalized by the caller.
export type ThinkingLevelObservation = {
  provider: string;
  levels: ReadonlyMap<ReasoningEffort, number>;
};

type Graph<Edge> = ReadonlyMap<ReasoningEffort, ReadonlyMap<ReasoningEffort, Edge>>;
export type ThinkingLevelRatios = ReadonlyMap<string, Graph<number>>;

// Average each directed ratio within its provider. Never pair different models
// or evals: only levels within a single observation can contribute an edge.
export function buildThinkingLevelGraphs(
  observations: readonly ThinkingLevelObservation[],
): ThinkingLevelRatios {
  type Sample = { sum: number; count: number };
  const samples = new Map<string, Map<ReasoningEffort, Map<ReasoningEffort, Sample>>>();
  for (const { provider, levels } of observations) {
    const graph = samples.get(provider)
      ?? new Map<ReasoningEffort, Map<ReasoningEffort, Sample>>();
    samples.set(provider, graph);
    for (const [from, anchor] of levels) {
      if (!Number.isFinite(anchor) || anchor <= 0) continue;
      const edges = graph.get(from) ?? new Map<ReasoningEffort, Sample>();
      graph.set(from, edges);
      for (const [to, target] of levels) {
        const ratio = target / anchor;
        if (from === to || !Number.isFinite(ratio) || ratio < 0) continue;
        const sample = edges.get(to) ?? { sum: 0, count: 0 };
        sample.sum += ratio;
        sample.count += 1;
        edges.set(to, sample);
      }
    }
  }
  const graphs = new Map<string, Graph<number>>();
  for (const [provider, graph] of samples) {
    const averaged = new Map<ReasoningEffort, Map<ReasoningEffort, number>>();
    for (const [from, edges] of graph) {
      averaged.set(from, new Map(
        [...edges].map(([to, { sum, count }]) => [to, sum / count]),
      ));
    }
    graphs.set(provider, averaged);
  }
  return graphs;
}

// Breadth-first search: direct edges win, otherwise average the products of
// all shortest paths. A provider with no path has no estimate, not a fallback.
export function thinkingLevelRatio(
  graphs: ThinkingLevelRatios,
  provider: string,
  from: ReasoningEffort,
  to: ReasoningEffort,
): number | undefined {
  const graph = graphs.get(provider);
  if (!graph) return undefined;
  type Paths = { sum: number; count: number };
  let frontier = new Map<ReasoningEffort, Paths>([[from, { sum: 1, count: 1 }]]);
  const visited = new Set<ReasoningEffort>([from]);
  while (frontier.size > 0) {
    const next = new Map<ReasoningEffort, Paths>();
    for (const [level, paths] of frontier) {
      for (const [neighbor, ratio] of graph.get(level) ?? []) {
        if (visited.has(neighbor)) continue;
        const merged = next.get(neighbor) ?? { sum: 0, count: 0 };
        merged.sum += paths.sum * ratio;
        merged.count += paths.count;
        next.set(neighbor, merged);
      }
    }
    const result = next.get(to);
    if (result) return result.sum / result.count;
    for (const level of next.keys()) visited.add(level);
    frontier = next;
  }
  return undefined;
}
