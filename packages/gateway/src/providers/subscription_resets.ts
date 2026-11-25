import { createHash } from "node:crypto";

import { isRecord } from "@mupt-ai/dari-router/policy-engine";
import { subscriptionUsageFromWindows, type SubscriptionUsage } from "./subscription_limits.js";

/**
 * The provider endpoints behind banked limit resets and Claude Code's plan
 * usage report: the ChatGPT backend the Codex CLI uses and the claude.ai
 * OAuth endpoints Claude Code's `/limit-reset` uses. Hosted Dari and the
 * self-hosted gateway both spend resets through these.
 */

export const CODEX_BACKEND_URL = "https://chatgpt.com/backend-api";
export const CLAUDE_BASE_URL = "https://api.anthropic.com";
// Anthropic offers grants only to the Claude Code CLI surface.
const CLAUDE_USER_AGENT = "claude-cli/2.1.280 (external, cli)";
const CLAUDE_PROGRAM = "cedar_ember";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** A banked limit reset of a ChatGPT or Claude Code plan. */
export type BankedReset = {
  id: string;
  // A short name for the kind of reset, such as "Weekly reset".
  label: string;
  expiresAt: Date | null;
  // Whether the provider would honor it now.
  usable: boolean;
  // For a Claude grant, how many of its resets were left when it was read.
  remaining: number | null;
};

export type CodexAccess = { accessToken: string; accountId: string | null; baseUrl?: string };

export type CodexUsage = {
  allowed: boolean | null;
  limitReached: boolean | null;
  // [used_percent, reset_at unix seconds] for the primary and weekly windows.
  windows: Array<[number, number | null]>;
  availableResets: number;
};

export async function codexUsage(fetch: Fetch, access: CodexAccess): Promise<CodexUsage> {
  const body = await codexRequest(fetch, "GET", "/wham/usage", access);
  const rateLimit = isRecord(body.rate_limit) ? body.rate_limit : {};
  const windows: Array<[number, number | null]> = [];
  for (const name of ["primary_window", "secondary_window"]) {
    const window = rateLimit[name];
    if (!isRecord(window) || typeof window.used_percent !== "number") continue;
    windows.push([window.used_percent, Number.isInteger(window.reset_at) ? (window.reset_at as number) : null]);
  }
  const credits = body.rate_limit_reset_credits;
  const available = isRecord(credits) ? credits.available_count : 0;
  return {
    allowed: typeof rateLimit.allowed === "boolean" ? rateLimit.allowed : null,
    limitReached: typeof rateLimit.limit_reached === "boolean" ? rateLimit.limit_reached : null,
    windows,
    availableResets: Number.isInteger(available) ? Math.max(available as number, 0) : 0,
  };
}

/** Every banked reset the ChatGPT plan can still spend, the soonest to expire first. */
export async function codexResets(fetch: Fetch, access: CodexAccess): Promise<BankedReset[]> {
  const body = await codexRequest(fetch, "GET", "/wham/rate-limit-reset-credits", access);
  const credits = (Array.isArray(body.credits) ? body.credits : []).filter(
    (credit): credit is Record<string, unknown> & { id: string } =>
      isRecord(credit) && credit.reset_type === "codex_rate_limits" && credit.status === "available"
      && typeof credit.id === "string",
  );
  return soonestFirst(credits.map((credit) => ({
    id: credit.id,
    label: typeof credit.title === "string" ? credit.title : "Full reset",
    expiresAt: timestamp(credit.expires_at),
    usable: credit.is_supported_by_plan !== false,
    remaining: null,
  })));
}

/** Spend a ChatGPT credit; Codex's answer, "reset" when it restored the plan. */
export async function consumeCodexReset(
  fetch: Fetch,
  access: CodexAccess,
  creditId: string,
  requestId: string,
): Promise<string> {
  const body = await codexRequest(fetch, "POST", "/wham/rate-limit-reset-credits/consume", access, {
    redeem_request_id: requestId,
    credit_id: creditId,
  });
  return typeof body.code === "string" ? body.code : "unknown";
}

async function codexRequest(
  fetch: Fetch,
  method: string,
  path: string,
  access: CodexAccess,
  payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${access.accessToken}`,
    "User-Agent": "Dari/1.0",
  };
  if (access.accountId) headers["ChatGPT-Account-Id"] = access.accountId;
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  return await readJson(fetch, `${(access.baseUrl ?? CODEX_BACKEND_URL).replace(/\/+$/, "")}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(8_000),
  }, "Codex usage request");
}

/** Claude Code's usage report: the plan's windows and its banked resets. */
export async function claudeUsageReport(fetch: Fetch, token: string, baseUrl?: string): Promise<Record<string, unknown>> {
  return await claudeRequest(fetch, "GET", "/api/oauth/usage?cedar_ember=1&skip_spend=1", token, baseUrl);
}

/** The plan's 5 hour and weekly windows from a usage report. */
export function claudeUsageFromReport(report: Record<string, unknown>, now: Date): SubscriptionUsage | null {
  return subscriptionUsageFromWindows(([["five_hour", 5 * 60], ["seven_day", 7 * 24 * 60]] as const).map(([name, minutes]) => {
    const window = isRecord(report[name]) ? report[name] : {};
    const used = window.utilization;
    return {
      minutes,
      used: typeof used === "number" ? used / 100 : NaN,
      resetsAt: timestamp(window.resets_at),
    };
  }), now);
}

/** Every limit reset a usage report says the account has left, the soonest to expire first. */
export function claudeResetsFromReport(report: Record<string, unknown>): BankedReset[] {
  const status = isRecord(report.cedar_ember) ? report.cedar_ember : {};
  const eligible = status.eligible === true;
  const grants = (Array.isArray(status.grants) ? status.grants : []).filter(
    (grant): grant is Record<string, unknown> & { id: string; resets_left: number } =>
      isRecord(grant) && typeof grant.id === "string" && Number.isInteger(grant.resets_left) && (grant.resets_left as number) > 0,
  );
  return soonestFirst(grants.map((grant) => ({
    id: grant.id,
    label: claudeGrantKind(grant),
    expiresAt: timestamp(grant.ends_at),
    usable: eligible && grant.usable_now === true,
    remaining: grant.resets_left,
  })));
}

/** The grant Claude would spend next, when it can be spent now. */
export function nextClaudeGrant(report: Record<string, unknown>): string | null {
  const status = report.cedar_ember;
  if (!isRecord(status) || status.eligible !== true) return null;
  const grantId = status.next_grant_id;
  const grant = (Array.isArray(status.grants) ? status.grants : []).find(
    (candidate) => isRecord(candidate) && candidate.id === grantId,
  );
  return typeof grantId === "string" && isRecord(grant) && grant.usable_now === true ? grantId : null;
}

/** The claude.ai organization the account's resets are claimed in. */
export async function claudeOrganizationUuid(fetch: Fetch, token: string, baseUrl?: string): Promise<string | null> {
  const profile = await claudeRequest(fetch, "GET", "/api/oauth/profile", token, baseUrl);
  const organization = profile.organization;
  const uuid = isRecord(organization) ? organization.uuid : undefined;
  return typeof uuid === "string" && uuid ? uuid : null;
}

/** Claim one reset of a grant; Claude's answer, "reset" when it restored the plan. */
export async function claimClaudeReset(
  fetch: Fetch,
  token: string,
  claim: { organizationUuid: string; grantId: string; requestId: string },
  baseUrl?: string,
): Promise<string> {
  const body = await claudeRequest(
    fetch,
    "POST",
    `/api/organizations/${claim.organizationUuid}/reset_rate_limits`,
    token,
    baseUrl,
    { program: CLAUDE_PROGRAM, grant_id: claim.grantId, request_id: claim.requestId },
  );
  return typeof body.result === "string" ? body.result : "unknown";
}

// Name a grant by the limit it clears: Claude's own labels are sentences.
function claudeGrantKind(grant: Record<string, unknown>): string {
  const clears = Array.isArray(grant.clears) ? grant.clears : [];
  if (clears.includes("seven_day")) return "Weekly reset";
  // The weekly limit Claude reports beside it as the Fable window.
  if (clears.includes("seven_day_overage_included")) return "Fable reset";
  return "Limit reset";
}

async function claudeRequest(
  fetch: Fetch,
  method: string,
  path: string,
  token: string,
  baseUrl?: string,
  payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": CLAUDE_USER_AGENT,
  };
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  return await readJson(fetch, `${(baseUrl ?? CLAUDE_BASE_URL).replace(/\/+$/, "")}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(25_000),
  }, "Claude reset request");
}

async function readJson(fetch: Fetch, url: string, init: RequestInit, operation: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 429
      ? `${operation} was rate limited; try again in a minute.`
      : `${operation} failed with status ${response.status}.`);
  }
  const body: unknown = await response.json().catch(() => {
    throw new Error(`${operation} failed.`);
  });
  if (!isRecord(body)) throw new Error(`${operation} returned an invalid response.`);
  return body;
}

function soonestFirst(resets: BankedReset[]): BankedReset[] {
  const at = (reset: BankedReset) => reset.expiresAt?.getTime() ?? Infinity;
  return resets.sort((a, b) => at(a) - at(b));
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** RFC 4122 name-based UUID (version 5), as Python's `uuid.uuid5`. */
export function uuidv5(name: string, namespace: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
