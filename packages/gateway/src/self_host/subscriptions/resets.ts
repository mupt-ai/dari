import {
  claimClaudeReset,
  claudeOrganizationUuid,
  claudeResetsFromReport,
  claudeUsageFromReport,
  claudeUsageReport,
  codexResets,
  codexUsage,
  consumeCodexReset,
  nextClaudeGrant,
  uuidv5,
  type BankedReset,
  type CodexAccess,
  type CodexUsage,
} from "../../providers/subscription_resets.js";
import { codexUsageFromReport, fetchCodexUsageReport } from "../../providers/codex_usage.js";
import { shouldSpendReset, type Source } from "../../models/sources.js";
import { refreshedAccessToken } from "./access.js";
import type { OAuthFetch, SubscriptionProvider } from "./oauth.js";
import { isHeld, type SubscriptionCredential, type SubscriptionStore } from "./store.js";

/**
 * Banked limit resets of the gateway owner's ChatGPT and Claude Code plans, as
 * hosted Dari spends them (dari-routing-backend subscription_recovery.ts and
 * the control plane's subscription_resets.py): listed and spent on request,
 * and spent once every plan of its provider is held when the model's sources
 * say so (models/sources.ts shouldSpendReset).
 */

/** The held model's sources and its router's reset threshold. */
export type ResetPolicy = { sources: readonly Source[]; resetMinHours: number };

/** Where the gateway reaches Claude and ChatGPT: the config's endpoints, or the providers'. */
export type ProviderBaseUrls = { claude?: string; codex?: string };

export function providerBaseUrls(providers: Record<string, { baseUrl: string }>): ProviderBaseUrls {
  return {
    ...(providers.anthropic === undefined ? {} : { claude: providers.anthropic.baseUrl }),
    ...(providers["openai-codex"] === undefined ? {} : { codex: providers["openai-codex"].baseUrl }),
  };
}

export type ResetDeps = {
  store: SubscriptionStore;
  fetch: OAuthFetch;
  baseUrls?: ProviderBaseUrls;
  now?: Date;
};

// Names a spend, so a repeat reuses its request id (the control plane's).
const USE_NAMESPACE = "0c7d4b2e-8f1a-4c3e-9b6d-5a2e1f0d7c48";
const CODEX_REDEEM_NAMESPACE = "5f0b3d1e-6a43-4f0e-9a4f-1c2d0b8e7a11";
const CLAUDE_CLAIM_NAMESPACE = "9b6e2f4a-3c1d-4e8b-a7f0-2d5c8e1b6a93";
// A window this full is the one blocking the plan.
const EXHAUSTED_PERCENT = 99;

const RESETTABLE: readonly SubscriptionProvider[] = ["anthropic_claude_code", "openai_codex"];

export function hasBankedResets(credential: SubscriptionCredential): boolean {
  return RESETTABLE.includes(credential.provider);
}

/** The plan's banked resets, the soonest to expire first. */
export async function listResets(deps: ResetDeps, credential: SubscriptionCredential): Promise<BankedReset[]> {
  const token = await refreshedAccessToken(deps.store, credential, deps);
  if (credential.provider === "openai_codex") return await codexResets(deps.fetch, codexAccess(deps, credential, token));
  return claudeResetsFromReport(await claudeUsageReport(deps.fetch, token, deps.baseUrls?.claude));
}

/**
 * Spend one reset now: the provider's answer, "reset" when it restored the
 * plan, which is then released. Checked against a fresh list first: one spent
 * or gone answers "unavailable", one not usable yet "not_usable".
 */
export async function useReset(deps: ResetDeps, credential: SubscriptionCredential, resetId: string): Promise<string> {
  const now = deps.now ?? new Date();
  const token = await refreshedAccessToken(deps.store, credential, deps);
  const reset = (await listResets(deps, credential)).find((candidate) => candidate.id === resetId);
  if (reset === undefined) return "unavailable";
  if (!reset.usable) return "not_usable";
  let result: string;
  if (credential.provider === "openai_codex") {
    // A credit is spent once, so a repeated request names the same spend.
    result = await consumeCodexReset(deps.fetch, codexAccess(deps, credential, token), resetId, uuidv5(`${credential.id}:${resetId}`, USE_NAMESPACE));
  } else {
    const organizationUuid = await claudeOrganizationUuid(deps.fetch, token, deps.baseUrls?.claude);
    if (organizationUuid === null) throw new Error("Claude did not name the account's organization.");
    result = await claimClaudeReset(deps.fetch, token, {
      organizationUuid,
      grantId: resetId,
      // The grant and how many of its resets were left: a retry is the same
      // request, and the grant's next reset a new one.
      requestId: uuidv5(`${credential.id}:${resetId}:${reset.remaining}`, USE_NAMESPACE),
    }, deps.baseUrls?.claude);
  }
  if (result === "reset") await readmit(deps, credential, token, now);
  return result;
}

/**
 * After a usage-limit hold on one of the owner's plans: correct a ChatGPT
 * plan's hold from Codex's report, and once every plan of the provider is
 * held, release one the provider already serves again or spend one banked
 * reset on the plan that would stay out longest, when the policy says so.
 * Returns whether a plan of the provider serves now.
 */
export async function recoverHeldPlans(deps: ResetDeps, held: SubscriptionCredential, policy: ResetPolicy): Promise<boolean> {
  const now = deps.now ?? new Date();
  const serving = () => deps.store.activeCredential(held.provider, now) !== null;
  try {
    if (held.provider === "openai_codex") await recoverCodex(deps, held, policy, now, serving);
    else if (held.provider === "anthropic_claude_code" && !serving()) await recoverClaude(deps, policy, now);
  } catch (error) {
    console.error("subscription recovery failed", error instanceof Error ? error.message : String(error));
  }
  return serving();
}

async function recoverClaude(deps: ResetDeps, policy: ResetPolicy, now: Date): Promise<void> {
  const candidates = deps.store.list("anthropic_claude_code")
    .filter((plan) => isHeld(plan, now))
    .sort((a, b) => b.unavailableUntil!.getTime() - a.unavailableUntil!.getTime());
  for (const plan of candidates) {
    const outcome = await claimOnHold(deps, plan, policy, now);
    // At most one reset per outage.
    if (outcome !== "skipped") return;
  }
}

async function claimOnHold(deps: ResetDeps, plan: SubscriptionCredential, policy: ResetPolicy, now: Date): Promise<"skipped" | "spent" | "restored"> {
  let token: string;
  let grant: { grantId: string; organizationUuid: string } | null = null;
  try {
    token = await refreshedAccessToken(deps.store, plan, deps);
    const report = await claudeUsageReport(deps.fetch, token, deps.baseUrls?.claude);
    const resets = claudeResetsFromReport(report);
    if (!shouldSpendReset({ ...policy, returnsAt: plan.unavailableUntil!, resets, now })) return "skipped";
    const grantId = nextClaudeGrant(report);
    const organizationUuid = grantId === null ? null : await claudeOrganizationUuid(deps.fetch, token, deps.baseUrls?.claude);
    if (grantId !== null && organizationUuid !== null) grant = { grantId, organizationUuid };
  } catch (error) {
    console.error("claude reset grant read failed", error instanceof Error ? error.message : String(error));
    return "skipped";
  }
  if (grant === null) return "skipped";
  let result: string;
  try {
    result = await claimClaudeReset(deps.fetch, token, {
      ...grant,
      // One outage is one held window, so its end names it.
      requestId: uuidv5(`${plan.id}:${Math.trunc(plan.unavailableUntil!.getTime() / 1000)}`, CLAUDE_CLAIM_NAMESPACE),
    }, deps.baseUrls?.claude);
  } catch (error) {
    // The reset may have been spent; never risk a second one.
    console.error("claude reset claim failed", error instanceof Error ? error.message : String(error));
    return "spent";
  }
  if (result === "reset") {
    await readmit(deps, plan, token, now);
    return "restored";
  }
  // Claude declined without spending a reset; another plan may claim one.
  return ["not_limited", "ineligible", "cooldown"].includes(result) ? "skipped" : "spent";
}

async function recoverCodex(deps: ResetDeps, held: SubscriptionCredential, policy: ResetPolicy, now: Date, serving: () => boolean): Promise<void> {
  const usages = new Map<string, CodexUsage | null>();
  const usageOf = async (plan: SubscriptionCredential) => {
    if (!usages.has(plan.id)) {
      try {
        usages.set(plan.id, await codexUsage(deps.fetch, codexAccess(deps, plan, await refreshedAccessToken(deps.store, plan, deps))));
      } catch (error) {
        // The report only refines a hold that already landed.
        console.error("codex usage read failed", error instanceof Error ? error.message : String(error));
        usages.set(plan.id, null);
      }
    }
    return usages.get(plan.id)!;
  };
  const heldUsage = await usageOf(held);
  const recovery = heldUsage === null ? null : naturalRecovery(heldUsage, now);
  // Holds only grow.
  if (recovery !== null) deps.store.markUnavailable(held.id, recovery, held.unavailableReason ?? "ChatGPT usage limit reached.", now);
  if (serving()) return;
  const candidates: Array<{ plan: SubscriptionCredential; recovery: Date }> = [];
  for (const plan of deps.store.list("openai_codex")) {
    const usage = await usageOf(plan);
    if (usage === null) continue;
    // The just-held plan's report can lag its own refusal.
    if (usage.allowed === true && plan.id !== held.id) {
      deps.store.markAvailable(plan.name, now);
      return;
    }
    const back = naturalRecovery(usage, now);
    if (back !== null && usage.availableResets > 0) candidates.push({ plan, recovery: back });
  }
  // The plan that would stay out longest gains the most from a reset.
  candidates.sort((a, b) => b.recovery.getTime() - a.recovery.getTime());
  for (const { plan, recovery: back } of candidates) {
    const outcome = await redeemOnHold(deps, plan, back, policy, now);
    // At most one credit per outage, even when Codex has not caught up.
    if (outcome !== "skipped") return;
  }
}

async function redeemOnHold(deps: ResetDeps, plan: SubscriptionCredential, recovery: Date, policy: ResetPolicy, now: Date): Promise<"skipped" | "spent" | "restored"> {
  let access: CodexAccess;
  let resets: BankedReset[];
  try {
    access = codexAccess(deps, plan, await refreshedAccessToken(deps.store, plan, deps));
    resets = await codexResets(deps.fetch, access);
  } catch (error) {
    console.error("codex reset credit read failed", error instanceof Error ? error.message : String(error));
    return "skipped";
  }
  if (!shouldSpendReset({ ...policy, returnsAt: recovery, resets, now })) return "skipped";
  const creditId = resets[0]!.id;
  let code: string;
  try {
    // One outage is one exhausted window, so its reset names it.
    code = await consumeCodexReset(deps.fetch, access, creditId, uuidv5(`${plan.id}:${Math.trunc(recovery.getTime() / 1000)}`, CODEX_REDEEM_NAMESPACE));
  } catch (error) {
    // The credit may have been spent; never risk a second one.
    console.error("codex reset redemption failed", error instanceof Error ? error.message : String(error));
    return "spent";
  }
  // Codex declined without spending a credit; another plan may redeem one.
  if (code === "no_credit" || code === "nothing_to_reset") return "skipped";
  // A repeat for this outage restores only once Codex says the plan serves.
  const restored = code === "reset"
    || (code === "already_redeemed" && (await codexUsage(deps.fetch, access).catch(() => null))?.allowed === true);
  if (!restored) return "spent";
  await readmit(deps, plan, access.accessToken, now);
  return "restored";
}

// When a blocked ChatGPT plan returns on its own: the latest exhausted window's reset.
function naturalRecovery(usage: CodexUsage, now: Date): Date | null {
  if (usage.allowed !== false && usage.limitReached !== true) return null;
  const future = usage.windows
    .filter(([used, resetAt]) => used >= EXHAUSTED_PERCENT && resetAt !== null && resetAt * 1000 > now.getTime())
    .map(([, resetAt]) => resetAt! * 1000);
  return future.length > 0 ? new Date(Math.max(...future)) : null;
}

// A plan the provider restored: release its holds, and record its usage now
// when it can be read (a failed read leaves it to the next response).
async function readmit(deps: ResetDeps, plan: SubscriptionCredential, token: string, now: Date): Promise<void> {
  deps.store.markAvailable(plan.name, now);
  try {
    const usage = plan.provider === "openai_codex"
      ? codexUsageFromReport(await fetchCodexUsageReport({ accessToken: token, fetch: deps.fetch as typeof fetch, ...(deps.baseUrls?.codex ? { baseUrl: deps.baseUrls.codex } : {}) }), now)
      : claudeUsageFromReport(await claudeUsageReport(deps.fetch, token, deps.baseUrls?.claude), now);
    if (usage !== null) deps.store.recordUsage(plan.id, usage, now);
  } catch (error) {
    console.error("usage read after a reset failed", error instanceof Error ? error.message : String(error));
  }
}

function codexAccess(deps: ResetDeps, plan: SubscriptionCredential, token: string): CodexAccess {
  return { accessToken: token, accountId: plan.accountId, ...(deps.baseUrls?.codex ? { baseUrl: deps.baseUrls.codex } : {}) };
}
