/* A Dari Link grant's budget: the most tokens its app may use in each rolling
   window, across all of the grant's plans and API keys together.

   A grant's tokens are what Dari recorded for its requests (child tokens
   included): input + output + cache read + cache write, the same total the
   Connected Apps page shows. A window's used tokens are those of requests
   received in its last `windowMinutes`. Each request is checked before it is
   served, so one in flight may take a window past its cap.

   A window at its cap is back once enough of its oldest requests roll off to
   bring it under the cap again: `resetsAt` is when that happens.

   A grant may also limit what it spends on each of its plans and API keys in
   a calendar month (UTC): an API key's spend is what its provider charged,
   and a plan's is what its requests would have cost at API prices. A plan or
   key at its limit leaves the grant until the month ends; the grant serves on
   the rest. */

import type { LinkBudget, LinkLimit, LinkSpend, LinkUsageTotals } from "../platform/platform.js";

/** The windows a budget can cap: five hours and one week. */
export const LINK_BUDGET_WINDOW_MINUTES = [300, 10080] as const;

/** The tokens a request used, as each kind is recorded. */
export type LinkTokenCounts = Pick<LinkUsageTotals, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">;

/** What a budget counts, and Connected Apps shows: every token, of every kind. */
export function linkTokens(counts: LinkTokenCounts): number {
  return counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens;
}

/**
 * What one of a grant's requests used, when it was received, what it cost in
 * US dollars, and the plan or key that served it (null when none did).
 */
export type BudgetUse = LinkTokenCounts & { at: Date; costUsd: number; credentialId: string | null };

/** A budget window as it stands for a grant; `resetsAt` is set only at the cap. */
export type BudgetStanding = { windowMinutes: number; maxTokens: number; usedTokens: number; resetsAt: Date | null };

/** Each budget window as it stands, from the grant's uses. */
export function budgetStandings(budget: readonly LinkBudget[], uses: readonly BudgetUse[], now: Date): BudgetStanding[] {
  return budget.map((entry) => {
    const windowMs = entry.windowMinutes * 60_000;
    const live = uses
      .filter((use) => use.at.getTime() > now.getTime() - windowMs)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const usedTokens = live.reduce((sum, use) => sum + linkTokens(use), 0);
    let resetsAt: Date | null = null;
    let remaining = usedTokens;
    for (const use of live) {
      if (remaining < entry.maxTokens) break;
      remaining -= linkTokens(use);
      resetsAt = new Date(use.at.getTime() + windowMs);
    }
    return { windowMinutes: entry.windowMinutes, maxTokens: entry.maxTokens, usedTokens, resetsAt };
  });
}

/** Undefined while the grant is within its budget; otherwise when it is back. */
export function overBudgetUntil(standings: readonly BudgetStanding[]): Date | undefined {
  const resets = standings.flatMap((standing) => standing.resetsAt === null ? [] : [standing.resetsAt.getTime()]);
  return resets.length === 0 ? undefined : new Date(Math.max(...resets));
}

/** How far back a budget's windows reach, in milliseconds; 0 for none. */
export function budgetLookbackMs(budget: readonly LinkBudget[]): number {
  return Math.max(0, ...budget.map((entry) => entry.windowMinutes)) * 60_000;
}

/** The start of this calendar month, UTC. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** When this month's spend limits lift: the start of the next calendar month, UTC. */
export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** The earliest use a grant's budget and spend need: its windows, and this month. */
export function usesSince(budget: readonly LinkBudget[], now: Date): number {
  return Math.min(now.getTime() - budgetLookbackMs(budget), monthStart(now).getTime());
}

/** Each granted plan or key's spend this month, with its limit when it has one. */
export function grantSpend(
  credentialIds: Iterable<string>,
  limits: readonly LinkLimit[],
  uses: readonly BudgetUse[],
  now: Date,
): LinkSpend[] {
  const since = monthStart(now).getTime();
  const spent = new Map<string, number>();
  for (const use of uses) {
    if (use.credentialId === null || use.at.getTime() < since) continue;
    spent.set(use.credentialId, (spent.get(use.credentialId) ?? 0) + use.costUsd);
  }
  return [...credentialIds].map((credentialId) => {
    const spentUsd = spent.get(credentialId) ?? 0;
    const monthlyUsd = limits.find((limit) => limit.credentialId === credentialId)?.monthlyUsd ?? null;
    return { credentialId, spentUsd, monthlyUsd, reached: monthlyUsd !== null && spentUsd >= monthlyUsd };
  });
}

/** Limits from a request: `[{credential_id, monthly_usd}]`, each a distinct plan or key and a dollar amount of 0 or more. */
export function validLimits(value: unknown): LinkLimit[] | null {
  if (!Array.isArray(value)) return null;
  const limits: LinkLimit[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { credential_id: credentialId, monthly_usd: monthlyUsd } = entry as Record<string, unknown>;
    if (
      typeof credentialId !== "string" || credentialId.length === 0
      || typeof monthlyUsd !== "number" || !Number.isFinite(monthlyUsd) || monthlyUsd < 0
      || limits.some((other) => other.credentialId === credentialId)
    ) {
      return null;
    }
    limits.push({ credentialId, monthlyUsd });
  }
  return limits;
}

export function limitsBody(limits: readonly LinkLimit[]) {
  return limits.map((limit) => ({ credential_id: limit.credentialId, monthly_usd: limit.monthlyUsd }));
}

export function spendBody(spend: readonly LinkSpend[]) {
  return spend.map((entry) => ({
    credential_id: entry.credentialId,
    spent_usd: entry.spentUsd,
    monthly_usd: entry.monthlyUsd,
    reached: entry.reached,
  }));
}

/** A budget from a request: five-hour and weekly windows, each a positive whole token cap. */
export function validBudget(value: unknown): LinkBudget[] | null {
  if (!Array.isArray(value)) return null;
  const budget: LinkBudget[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { window_minutes: minutes, max_tokens: tokens } = entry as Record<string, unknown>;
    if (
      !(LINK_BUDGET_WINDOW_MINUTES as readonly unknown[]).includes(minutes)
      || typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens <= 0
      || budget.some((other) => other.windowMinutes === minutes)
    ) {
      return null;
    }
    budget.push({ windowMinutes: minutes as number, maxTokens: tokens });
  }
  return budget.sort((a, b) => a.windowMinutes - b.windowMinutes);
}

export function budgetBody(budget: readonly LinkBudget[]) {
  return budget.map((entry) => ({ window_minutes: entry.windowMinutes, max_tokens: entry.maxTokens }));
}
