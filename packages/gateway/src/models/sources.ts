// How a router serves one model: the whole policy lives in this file.
//
// Each model on a router lists its sources, tried in order:
//   "plan"  the user's subscriptions that serve the model
//   "reset"   when those plans are all at their limit, spend a banked reset
//             to bring one back (only right after "plan")
//   "key"     the router's saved key for the model's provider (the user's own)
//   "managed" Dari's key for the provider, billed to the organization's credits
//
// Hosted Dari and the self-hosted gateway both call these functions.

export type Source = "plan" | "reset" | "key" | "managed";

export const SOURCES: readonly Source[] = ["plan", "reset", "key", "managed"];

// A model added to a hosted router without a list: its plans only, so
// nothing is ever billed unless the router says so.
export const HOSTED_DEFAULT_SOURCES: readonly Source[] = ["plan"];

// A model on a self-hosted gateway's router without a list: its plans, then
// the provider key the gateway was given. A self-hosted gateway has no
// managed keys.
export const SELF_HOSTED_DEFAULT_SOURCES: readonly Source[] = ["plan", "key"];

// Spend a banked reset only when the plan would otherwise stay out this long.
export const DEFAULT_RESET_MIN_HOURS = 24;

/** The list as given, or why it is not a valid list of sources. */
export function checkSources(list: unknown): { sources: Source[] } | { error: string } {
  if (!Array.isArray(list)) return { error: "Sources must be a list of plan, reset, key, and managed." };
  const sources: Source[] = [];
  for (const item of list) {
    if (!SOURCES.includes(item as Source)) return { error: `Unknown source ${JSON.stringify(item)}; use plan, reset, key, or managed.` };
    if (sources.includes(item as Source)) return { error: `Source ${item} is listed twice.` };
    sources.push(item as Source);
  }
  const reset = sources.indexOf("reset");
  if (reset !== -1 && sources[reset - 1] !== "plan") return { error: "Source reset must come right after plan." };
  return { sources };
}

/** One plan that offers the model, and how to serve with it. */
export type PlanOption<Candidate> = {
  // Whether this plan serves the client asking (a Claude Code plan serves
  // only Claude Code, a Muse Code plan only Muse Code).
  servesClient: boolean;
  // The way to serve with the user's plan of this kind, or null when they
  // have none or it is at its limit.
  candidate: () => Promise<Candidate | null>;
};

/**
 * The ways to serve one model, in its sources' order. The first serves the
 * request; the rest are its fallbacks.
 */
export async function candidatesFor<Candidate>(
  sources: readonly Source[],
  plans: readonly PlanOption<Candidate>[],
  keys: {
    // The way to serve with the router's saved key for the provider, or null
    // when it has none.
    key: () => Promise<Candidate | null>;
    // The way to serve with Dari's managed key, or null when there is none
    // for this provider (always null on a self-hosted gateway).
    managed: () => Promise<Candidate | null>;
  },
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const source of sources) {
    if (source === "plan") {
      for (const plan of plans) {
        if (!plan.servesClient) continue;
        const candidate = await plan.candidate();
        if (candidate !== null) candidates.push(candidate);
      }
    }
    if (source === "key") {
      const candidate = await keys.key();
      if (candidate !== null) candidates.push(candidate);
    }
    if (source === "managed") {
      const candidate = await keys.managed();
      if (candidate !== null) candidates.push(candidate);
    }
    // "reset" adds no candidate here: it decides what happens when a plan
    // runs out mid-request (shouldSpendReset).
  }
  return candidates;
}

/**
 * A plan just hit its limit and no other plan of its kind can serve. Whether
 * to spend one of its banked resets to bring it back now.
 */
export function shouldSpendReset(args: {
  sources: readonly Source[];
  resetMinHours: number;
  // When the plan comes back on its own.
  returnsAt: Date;
  // The plan's banked resets; a null expiry never expires.
  resets: ReadonlyArray<{ expiresAt: Date | null }>;
  now: Date;
}): boolean {
  if (!args.sources.includes("reset")) return false;
  if (args.resets.length === 0) return false;
  // A long wait is worth a reset.
  const waitHours = (args.returnsAt.getTime() - args.now.getTime()) / 3_600_000;
  if (waitHours >= args.resetMinHours) return true;
  // A reset that would expire before the plan comes back is lost anyway.
  for (const reset of args.resets) {
    if (reset.expiresAt !== null && reset.expiresAt < args.returnsAt) return true;
  }
  return false;
}
