import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import { providerFailureMessage } from "../runtime/provider_stream_outcome.js";
import type { ProviderKeySource, SubscriptionKind } from "../types.js";
import type { CapturedProviderResponse } from "./response_capture.js";

export type SubscriptionOAuthProvider = SubscriptionKind;

export type SubscriptionUsageLimit = {
  oauthProvider: SubscriptionOAuthProvider;
  resetsAt: Date;
  reason: string;
  // Set when only this model is at its own limit (such as a weekly cap on one
  // model family): the plan still serves the router's other models.
  model?: string;
  // A retry is served: the platform made the user's next subscription active,
  // or, for a model limit, held only that model so the router's other models
  // serve.
  switched?: boolean;
};

/** One quota window of a plan: its length, share used (0 to 1), and reset. */
export type SubscriptionUsageWindow = {
  // Absent for shared plan quota; a family limit must not exhaust the plan.
  modelFamily?: "fable";
  minutes: number;
  utilization: number;
  resetsAt: Date;
};

/**
 * How much of a subscription's quota is used, from a successful response.
 * `windows` lists every window with a future reset, shortest first;
 * Model-family windows are separate meters and never bind the whole plan.
 * `utilization` and `resetsAt` are the shared binding window's: the one closest to
 * its limit.
 */
export type SubscriptionUsage = {
  utilization: number;
  resetsAt: Date;
  windows: SubscriptionUsageWindow[];
};

const FIVE_HOURS = 5 * 60;
const ONE_WEEK = 7 * 24 * 60;

// Claude Code's unified limiter reports each window on every response, the
// same headers Claude Code itself reads: `-utilization` as a fraction of the
// window and `-reset` in unix seconds.
const CLAUDE_CODE_USAGE_WINDOWS = [["5h", FIVE_HOURS], ["7d", ONE_WEEK], ["7d_oi", ONE_WEEK]] as const;

// The ChatGPT backend reports each Codex window on every response, the same
// headers the Codex CLI reads: `-used-percent` out of 100, `-reset-at` in
// unix seconds, and `-window-minutes`. The defaults are a ChatGPT plan's.
export const CODEX_USAGE_WINDOWS = [["primary", FIVE_HOURS], ["secondary", ONE_WEEK]] as const;

/** Usage from raw windows, dropping malformed or already-reset ones. */
export function subscriptionUsageFromWindows(
  raw: Array<{ minutes: number; used: number; resetsAt: Date | null; modelFamily?: "fable" }>,
  now: Date,
): SubscriptionUsage | null {
  const windows = raw
    .filter((window) => Number.isFinite(window.used) && window.resetsAt !== null && window.resetsAt > now)
    .map((window) => ({
      ...(window.modelFamily === undefined ? {} : { modelFamily: window.modelFamily }),
      minutes: window.minutes,
      utilization: Math.max(0, Math.min(1, window.used)),
      resetsAt: window.resetsAt as Date,
    }))
    .sort((a, b) => a.minutes - b.minutes || (a.modelFamily ?? "").localeCompare(b.modelFamily ?? ""));
  if (windows.length === 0) return null;
  const binding = windows.filter((window) => window.modelFamily === undefined)
    .reduce<SubscriptionUsageWindow | null>((a, b) => a === null || b.utilization > a.utilization ? b : a, null);
  // Family-only reports still carry useful meters, but no shared-plan usage.
  return { utilization: binding?.utilization ?? 0, resetsAt: binding?.resetsAt ?? windows[0]!.resetsAt, windows };
}

/**
 * The quota a successful subscription response reports used, or null when it
 * reports none: the most used of the plan's windows.
 */
export function subscriptionUsageFromHeaders(
  provider: string,
  keySource: ProviderKeySource,
  headers: Headers,
  now = new Date(),
): SubscriptionUsage | null {
  const oauthProvider = subscriptionOAuthProviderFor(provider, keySource);
  const windows = oauthProvider === "anthropic_claude_code"
    ? CLAUDE_CODE_USAGE_WINDOWS.map(([window, minutes]) => ({
      ...(window === "7d_oi" ? { modelFamily: "fable" as const } : {}),
      minutes,
      used: Number(headers.get(`anthropic-ratelimit-unified-${window}-utilization`) ?? NaN),
      resetsAt: unixSecondsDeadline(headers.get(`anthropic-ratelimit-unified-${window}-reset`), now),
    }))
    : oauthProvider === "openai_codex"
      ? CODEX_USAGE_WINDOWS.map(([window, minutes]) => ({
        minutes: Number(headers.get(`x-codex-${window}-window-minutes`)) || minutes,
        used: Number(headers.get(`x-codex-${window}-used-percent`) ?? NaN) / 100,
        resetsAt: unixSecondsDeadline(headers.get(`x-codex-${window}-reset-at`), now),
      }))
      : [];
  return subscriptionUsageFromWindows(windows, now);
}

/**
 * The plan usage a Muse Code stream reports as its last event,
 * `response.subscription_usage`: `{window: {used_percent, resets_at,
 * window_duration_mins}, weekly: {used_percent, resets_at}, tier}`, the
 * current five hour block and the rolling week, resets in unix seconds and
 * percent that may exceed 100.
 */
export function museSubscriptionUsage(snapshot: unknown, now: Date): SubscriptionUsage | null {
  if (!isRecord(snapshot)) return null;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : NaN;
  return subscriptionUsageFromWindows(
    ([["window", FIVE_HOURS], ["weekly", ONE_WEEK]] as const).map(([name, minutes]) => {
      const raw = snapshot[name];
      const window = isRecord(raw) ? raw : {};
      const resetsAt = number(window.resets_at);
      return {
        minutes: number(window.window_duration_mins) > 0 ? Math.round(number(window.window_duration_mins)) : minutes,
        used: number(window.used_percent) / 100,
        resetsAt: Number.isNaN(resetsAt) ? null : new Date(resetsAt * 1000),
      };
    }),
    now,
  );
}

// OpenCode Go's windows by their usage report names; the monthly one follows
// the billing cycle.
const OPENCODE_GO_USAGE_WINDOWS = [["rolling", FIVE_HOURS], ["weekly", ONE_WEEK], ["monthly", 30 * 24 * 60]] as const;

// Each Token Pass billing period grants $150 of credit; Vercel reports only
// what remains, so usage is measured against the full grant.
const TOKEN_PASS_CREDIT_USD = 150;

/**
 * The Token Pass usage AI Gateway reports at `GET /v1/credits`:
 * `{token_pass: {remaining, resets_at} | null}`, remaining in USD as a string,
 * or null while Vercel cannot read the balance.
 */
export function tokenPassUsageFromCredits(credits: unknown, now: Date): SubscriptionUsage | null {
  const pass = isRecord(credits) && isRecord(credits.token_pass) ? credits.token_pass : null;
  if (pass === null || typeof pass.remaining !== "string" || typeof pass.resets_at !== "string") return null;
  return subscriptionUsageFromWindows(
    [{ minutes: 30 * 24 * 60, used: 1 - Number(pass.remaining) / TOKEN_PASS_CREDIT_USD, resetsAt: new Date(pass.resets_at) }],
    now,
  );
}

/**
 * The usage OpenCode Go reports at `GET /zen/go/v1/usage`, which OpenCode's
 * own `/usage` reads: `{usage: {rolling|weekly|monthly: {status: "ok" |
 * "rate-limited", percent, resetsAt}}}`, percent out of 100. A window Go
 * refuses on is at its limit whatever it rounds to.
 */
export function openCodeGoUsageFromReport(report: unknown, now: Date): SubscriptionUsage | null {
  const usage = isRecord(report) && isRecord(report.usage) ? report.usage : {};
  return subscriptionUsageFromWindows(
    OPENCODE_GO_USAGE_WINDOWS.map(([name, minutes]) => {
      const raw = usage[name];
      const meter = isRecord(raw) ? raw : {};
      const percent = typeof meter.percent === "number" ? meter.percent / 100 : NaN;
      const resetsAt = typeof meter.resetsAt === "string" ? new Date(meter.resetsAt) : null;
      return {
        minutes,
        used: meter.status === "rate-limited" && Number.isFinite(percent) ? 1 : percent,
        resetsAt: resetsAt === null || Number.isNaN(resetsAt.getTime()) ? null : resetsAt,
      };
    }),
    now,
  );
}

// Neither provider guarantees a reset time on every usage-limit response.
// Without one, hold the subscription out for an hour rather than hammering an
// exhausted plan on every request.
export const DEFAULT_USAGE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const FAILURE_MARKER = "subscription_usage_limit";

const SUBSCRIPTION_LABEL: Record<SubscriptionOAuthProvider, string> = {
  anthropic_claude_code: "Claude Code",
  openai_codex: "ChatGPT",
  meta_muse: "Muse Code",
  opencode_go: "OpenCode Go",
  xai_grok: "Grok",
  vercel_token_pass: "Vercel Token Pass",
};

// Providers whose plan page the accounts page links to for buying another.
const BUYABLE_SUBSCRIPTIONS = new Set<SubscriptionOAuthProvider>(["anthropic_claude_code", "openai_codex"]);

export function subscriptionOAuthProviderFor(
  provider: string,
  keySource: ProviderKeySource,
): SubscriptionOAuthProvider | null {
  if (keySource !== "subscription") return null;
  if (provider === "anthropic") return "anthropic_claude_code";
  if (provider === "openai" || provider === "openai-codex") return "openai_codex";
  if (provider === "meta") return "meta_muse";
  if (provider === "opencode-go") return "opencode_go";
  if (provider === "xai") return "xai_grok";
  if (provider === "vercel-token-pass") return "vercel_token_pass";
  return null;
}

/**
 * Recognize a personal subscription that has run out of quota. Claude Code
 * answers 429 with the unified rate-limit headers; the ChatGPT backend answers
 * 429 with a structured `error.code` and `resets_at`. Meta,
 * xAI, Kimi, and Vercel Token Pass document no usage-limit signature for their
 * plans, so any 429 on one holds it until the reset it gives, if any. OpenCode
 * Go names its refusal
 * `GoUsageLimitError`. The Codex WebSocket
 * transport bypasses fetch, so its usage-limit error only survives as message
 * text and is matched there without a reset time.
 */
export function detectSubscriptionUsageLimit(args: {
  provider: string;
  keySource: ProviderKeySource;
  // The routed model, named on a limit that covers only it.
  model: string;
  captured: CapturedProviderResponse | undefined;
  failure: Record<string, unknown>;
  now?: Date;
}): SubscriptionUsageLimit | null {
  const oauthProvider = subscriptionOAuthProviderFor(args.provider, args.keySource);
  if (oauthProvider === null) return null;
  const now = args.now ?? new Date();
  if (oauthProvider === "anthropic_claude_code") {
    return anthropicUsageLimit(args.captured, args.model, now);
  }
  if (oauthProvider === "opencode_go") return openCodeGoUsageLimit(args.captured, now);
  if (oauthProvider === "openai_codex") {
    return codexUsageLimit(args.captured, providerFailureMessage(args.failure), args.model, now);
  }
  return planRateLimit(oauthProvider, args.captured, now);
}

// Claude Code plans also cap some model families on their own
// (`seven_day_opus`, `seven_day_sonnet`). The representative claim names the
// window that refused. Fable uses `seven_day_overage_included` (the separate
// included Fable allowance), not the shared `seven_day` window.
// `-fallback: available` also says another model can still
// serve; either way the rest of the plan is not exhausted.
const ANTHROPIC_MODEL_CLAIM = /^(?:five_hour|seven_day)_(?:opus|sonnet|haiku|fable|mythos)(?:_|$)/;

function anthropicUsageLimit(
  captured: CapturedProviderResponse | undefined,
  model: string,
  now: Date,
): SubscriptionUsageLimit | null {
  if (captured === undefined || captured.status !== 429) return null;
  const status = captured.headers.get("anthropic-ratelimit-unified-status");
  const overageStatus = captured.headers.get("anthropic-ratelimit-unified-overage-status");
  // A plain per-minute rate limit is transient; only a rejected unified
  // window means the plan itself is exhausted.
  if (status !== "rejected" || (overageStatus !== null && overageStatus !== "rejected")) {
    return null;
  }
  const claim = captured.headers.get("anthropic-ratelimit-unified-representative-claim");
  const fableLimit = claim === "seven_day_overage_included";
  const modelLimit = fableLimit || (claim !== null && ANTHROPIC_MODEL_CLAIM.test(claim))
    || captured.headers.get("anthropic-ratelimit-unified-fallback") === "available";
  return {
    oauthProvider: "anthropic_claude_code",
    resetsAt: resetFromUnixSeconds(captured.headers.get("anthropic-ratelimit-unified-reset"), now),
    reason: fableLimit ? "Claude Code Fable usage limit reached." : claim
      ? `Claude Code ${claim.replaceAll("_", " ")} usage limit reached.`
      : modelLimit ? `Claude Code usage limit for ${model} reached.` : "Claude Code usage limit reached.",
    ...(modelLimit ? { model } : {}),
  };
}

const CODEX_LIMIT_CODES = new Set(["usage_limit_reached", "usage_not_included"]);
const CODEX_LIMIT_MESSAGE = /usage_limit_reached|usage_not_included|hit your ChatGPT usage limit|the usage limit has been reached/i;

function codexUsageLimit(
  captured: CapturedProviderResponse | undefined,
  failureMessage: string,
  model: string,
  now: Date,
): SubscriptionUsageLimit | null {
  if (captured !== undefined && captured.status === 429) {
    const error = codexErrorBody(captured.bodyText);
    const code = typeof error?.code === "string" ? error.code : "";
    if (error !== null && (CODEX_LIMIT_CODES.has(code) || failureMessage.match(CODEX_LIMIT_MESSAGE))) {
      const plan = typeof error.plan_type === "string" ? ` (${error.plan_type.toLowerCase()} plan)` : "";
      const resetsAt = laterReset(error.resets_at, captured.headers, now);
      return codexModelLimitExhausted(captured.headers)
        ? { oauthProvider: "openai_codex", resetsAt, reason: `ChatGPT usage limit for ${model} reached${plan}.`, model }
        : { oauthProvider: "openai_codex", resetsAt, reason: `ChatGPT usage limit reached${plan}.` };
    }
    return null;
  }
  if (!CODEX_LIMIT_MESSAGE.test(failureMessage)) return null;
  return {
    oauthProvider: "openai_codex",
    resetsAt: new Date(now.getTime() + DEFAULT_USAGE_LIMIT_WINDOW_MS),
    reason: "ChatGPT usage limit reached.",
  };
}

// The ChatGPT backend reports each limit as its own header family,
// `x-<limit>-primary-used-percent`, the plan's own being `x-codex-*`. A refusal
// while only another family is spent is that model's own cap.
function codexModelLimitExhausted(headers: Headers): boolean {
  let plan = false;
  let other = false;
  headers.forEach((value, name) => {
    const family = /^x-(.+)-(?:primary|secondary)-used-percent$/.exec(name.toLowerCase())?.[1];
    if (family === undefined || !(Number(value) >= 100)) return;
    if (family === "codex") plan = true;
    else other = true;
  });
  return other && !plan;
}

function planRateLimit(
  oauthProvider: SubscriptionOAuthProvider,
  captured: CapturedProviderResponse | undefined,
  now: Date,
): SubscriptionUsageLimit | null {
  if (captured === undefined || captured.status !== 429) return null;
  return {
    oauthProvider,
    resetsAt: laterReset(codexErrorBody(captured.bodyText)?.resets_at, captured.headers, now),
    reason: `${SUBSCRIPTION_LABEL[oauthProvider]} usage limit reached.`,
  };
}

// OpenCode Go refuses an exhausted plan with 429 and a `GoUsageLimitError`
// naming the window ("5 hour", "weekly", "monthly"), as OpenCode's own client
// recognizes it; an upstream's transient 429 on Go does not hold the plan.
// The reset is `resetsAt` (ISO) when sent, else Retry-After.
function openCodeGoUsageLimit(
  captured: CapturedProviderResponse | undefined,
  now: Date,
): SubscriptionUsageLimit | null {
  if (captured === undefined || captured.status !== 429) return null;
  if (!captured.bodyText.includes("GoUsageLimitError")) return null;
  const window = /"limitName"\s*:\s*"([^"]+)"/.exec(captured.bodyText)?.[1];
  const resetsAt = Date.parse(/"resetsAt"\s*:\s*"([^"]+)"/.exec(captured.bodyText)?.[1] ?? "");
  return {
    oauthProvider: "opencode_go",
    resetsAt: laterReset(Number.isNaN(resetsAt) ? undefined : resetsAt / 1000, captured.headers, now),
    reason: `OpenCode Go ${window ? `${window} ` : ""}usage limit reached.`,
  };
}

function codexErrorBody(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
  } catch {
    return null;
  }
}

// Codex may send both an absolute `resets_at` and Retry-After; the plan is
// back only once both have passed.
function laterReset(resetsAt: unknown, headers: Headers, now: Date): Date {
  const deadlines = [unixSecondsDeadline(resetsAt, now), retryAfterDeadline(headers, now)]
    .filter((deadline): deadline is Date => deadline !== null);
  if (deadlines.length === 0) return new Date(now.getTime() + DEFAULT_USAGE_LIMIT_WINDOW_MS);
  return new Date(Math.max(...deadlines.map((deadline) => deadline.getTime())));
}

function retryAfterDeadline(headers: Headers, now: Date): Date | null {
  const milliseconds = Number(headers.get("retry-after-ms") ?? NaN);
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    return new Date(now.getTime() + milliseconds);
  }
  const value = headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  const deadline = Number.isFinite(seconds)
    ? new Date(now.getTime() + seconds * 1000)
    : new Date(value);
  return deadline.getTime() > now.getTime() ? deadline : null;
}

function unixSecondsDeadline(value: unknown, now: Date): Date | null {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds * 1000 > now.getTime() ? new Date(seconds * 1000) : null;
}

function resetFromUnixSeconds(value: unknown, now: Date): Date {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (Number.isFinite(seconds) && seconds * 1000 > now.getTime()) {
    return new Date(seconds * 1000);
  }
  return new Date(now.getTime() + DEFAULT_USAGE_LIMIT_WINDOW_MS);
}

/** Tag a provider failure so telemetry and the terminal error know why. */
export function failureWithSubscriptionUsageLimit(
  failure: Record<string, unknown>,
  limit: SubscriptionUsageLimit,
): Record<string, unknown> {
  return {
    ...failure,
    [FAILURE_MARKER]: {
      oauth_provider: limit.oauthProvider,
      resets_at: limit.resetsAt.toISOString(),
      reason: limit.reason,
      ...(limit.model !== undefined ? { model: limit.model } : {}),
      ...(limit.switched === true ? { switched: true } : {}),
    },
  };
}

export function subscriptionUsageLimitFromFailure(
  failure: Record<string, unknown>,
): SubscriptionUsageLimit | null {
  const marker = failure[FAILURE_MARKER];
  if (!isRecord(marker)) return null;
  const oauthProvider = marker.oauth_provider;
  const resetsAt = typeof marker.resets_at === "string" ? new Date(marker.resets_at) : null;
  if (
    typeof oauthProvider !== "string" || !(oauthProvider in SUBSCRIPTION_LABEL)
    || resetsAt === null || Number.isNaN(resetsAt.getTime())
  ) {
    return null;
  }
  return {
    oauthProvider: oauthProvider as SubscriptionOAuthProvider,
    resetsAt,
    reason: typeof marker.reason === "string" ? marker.reason : "Subscription usage limit reached.",
    ...(typeof marker.model === "string" ? { model: marker.model } : {}),
    ...(marker.switched === true ? { switched: true } : {}),
  };
}

/**
 * The error for a plan out of quota with nothing to switch to. With the
 * platform's accounts page it links there; without one (a self-hosted
 * gateway) it points at `dari accounts`, which manages either.
 */
export function subscriptionUsageLimitMessage(limit: SubscriptionUsageLimit, accountsUrl?: string): string {
  const label = SUBSCRIPTION_LABEL[limit.oauthProvider];
  const scope = limit.model === undefined ? "" : ` for ${limit.model}`;
  const reached = `Your ${label} subscription usage limit${scope} is reached. It resets at ${limit.resetsAt.toISOString()}. `;
  if (accountsUrl === undefined) {
    return reached
      + `To keep going now, add another ${label} subscription or mark this one available early with \`dari accounts\`.`;
  }
  const buy = BUYABLE_SUBSCRIPTIONS.has(limit.oauthProvider)
    ? ` To keep going now, add another ${label} subscription at ${accountsUrl}?buy=${limit.oauthProvider}.`
    : "";
  return `${reached}Mark it available early at ${accountsUrl}.${buy}`;
}

/**
 * Codex shows its own usage-limit notice and drops the message of any other
 * 429, so an exhausted ChatGPT plan answers in the ChatGPT backend's shape:
 * the body type Codex recognizes, and how to add another plan as its promo
 * message. Codex renders "You've hit your usage limit. <promo>, or try again
 * at <reset>."
 */
export function codexUsageLimitError(limit: SubscriptionUsageLimit, accountsUrl?: string): {
  body: Record<string, unknown>;
  headers: Record<string, string>;
} | null {
  // Codex would show a per-model limit as the whole plan's.
  if (limit.oauthProvider !== "openai_codex" || limit.model !== undefined) return null;
  const promo = accountsUrl === undefined
    ? "Add another ChatGPT subscription with `dari accounts`"
    : `Add another ChatGPT subscription at ${accountsUrl}?buy=openai_codex`;
  return {
    body: { type: "usage_limit_reached", resets_at: Math.ceil(limit.resetsAt.getTime() / 1000) },
    headers: { "x-codex-promo-message": promo },
  };
}

export function subscriptionSwitchedMessage(limit: SubscriptionUsageLimit): string {
  const label = SUBSCRIPTION_LABEL[limit.oauthProvider];
  if (limit.model !== undefined) {
    return `Your ${label} subscription usage limit for ${limit.model} is reached; it resets at `
      + `${limit.resetsAt.toISOString()}. Dari routes to other models until then; retry the request.`;
  }
  return `Your ${label} subscription usage limit is reached. `
    + `Dari switched to your next connected ${label} subscription; retry the request.`;
}

export function retryAfterSeconds(limit: SubscriptionUsageLimit, now = new Date()): number {
  return Math.max(0, Math.ceil((limit.resetsAt.getTime() - now.getTime()) / 1000));
}
