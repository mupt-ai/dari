/* A Dari Link grant's budget: the most of each quota window of a granted plan
   its app may use, as a share of the window (0 to 1). One budget applies to
   every plan of the grant, each measured on its own.

   How much the app used is measured from the plan's own reports. Every
   response a plan serves reports each window's utilization; when the grant's
   request is the one reporting, the rise since the plan's previous report of
   that window is the grant's:

   - same window (its reset moved by less than SAME_WINDOW_MS): the rise, never
     below zero;
   - the window reset since the previous report: everything used in the new
     window;
   - no previous report of that window: nothing, as there is no baseline yet.

   That rise also holds whatever else used the plan between the two reports
   (the user's own Claude Code, claude.ai, another app), so a grant is charged
   at least what it used, possibly more; never less, except for its very first
   report and for traffic whose reports a plan skips (see the README). */

export type LinkBudget = { windowMinutes: number; maxShare: number };

export type BudgetWindow = { minutes: number; utilization: number; resetsAt: Date };

/** One window's share a grant was charged, by the window's reset. */
export type BudgetCharge = { minutes: number; resetsAt: Date; share: number };

/** A budget window as it stands for one plan. */
export type BudgetStanding = { windowMinutes: number; maxShare: number; usedShare: number; resetsAt: Date | null };

// Reports of one window put its reset within this of each other.
export const SAME_WINDOW_MS = 10 * 60_000;

/** What the grant whose request reported `current` is charged. */
export function budgetCharges(previous: readonly BudgetWindow[], current: readonly BudgetWindow[]): BudgetCharge[] {
  const charges: BudgetCharge[] = [];
  for (const window of current) {
    const before = previous.find((candidate) => candidate.minutes === window.minutes);
    if (before === undefined) continue;
    const gap = window.resetsAt.getTime() - before.resetsAt.getTime();
    const share = Math.abs(gap) < SAME_WINDOW_MS
      ? window.utilization - before.utilization
      : gap > 0
        ? window.utilization
        : 0;
    if (share > 0) charges.push({ minutes: window.minutes, resetsAt: window.resetsAt, share });
  }
  return charges;
}

/**
 * Each budget window as it stands for one plan, from the charges of windows
 * that have not reset. `resetsAt` is when the last of them resets.
 */
export function budgetStandings(
  budget: readonly LinkBudget[],
  charges: readonly BudgetCharge[],
  now: Date,
): BudgetStanding[] {
  return budget.map((entry) => {
    const live = charges.filter((charge) => charge.minutes === entry.windowMinutes && charge.resetsAt > now);
    return {
      windowMinutes: entry.windowMinutes,
      maxShare: entry.maxShare,
      usedShare: Math.min(1, live.reduce((sum, charge) => sum + charge.share, 0)),
      resetsAt: live.length === 0 ? null : new Date(Math.max(...live.map((charge) => charge.resetsAt.getTime()))),
    };
  });
}

/**
 * Null while the plan is within its budget; otherwise when it is back: the
 * last reset of the windows at their cap.
 */
export function overBudgetUntil(standings: readonly BudgetStanding[]): Date | null | undefined {
  const over = standings.filter((standing) => standing.usedShare >= standing.maxShare);
  if (over.length === 0) return undefined;
  const resets = over.map((standing) => standing.resetsAt?.getTime() ?? Number.NaN);
  return resets.some(Number.isNaN) ? null : new Date(Math.max(...resets));
}

/** A budget from a request: window lengths in minutes and shares in (0, 1]. */
export function validBudget(value: unknown): LinkBudget[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const budget: LinkBudget[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { window_minutes: minutes, max_share: share } = entry as Record<string, unknown>;
    if (
      typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0
      || typeof share !== "number" || !(share > 0 && share <= 1)
      || budget.some((other) => other.windowMinutes === minutes)
    ) {
      return null;
    }
    budget.push({ windowMinutes: minutes, maxShare: share });
  }
  return budget.sort((a, b) => a.windowMinutes - b.windowMinutes);
}

export function budgetBody(budget: readonly LinkBudget[]) {
  return budget.map((entry) => ({ window_minutes: entry.windowMinutes, max_share: entry.maxShare }));
}
