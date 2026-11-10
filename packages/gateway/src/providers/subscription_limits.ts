import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import { providerFailureMessage } from "../runtime/provider_stream_outcome.js";
import type { ProviderKeySource } from "../types.js";
import type { CapturedProviderResponse } from "./response_capture.js";

export type SubscriptionOAuthProvider = "anthropic_claude_code" | "openai_codex" | "meta_muse";

export type SubscriptionUsageLimit = {
  oauthProvider: SubscriptionOAuthProvider;
  resetsAt: Date;
  reason: string;
  // The platform made the user's next subscription active, so a retry
  // succeeds on it.
  switched?: boolean;
};

// Neither provider guarantees a reset time on every usage-limit response.
// Without one, hold the subscription out for an hour rather than hammering an
// exhausted plan on every request.
export const DEFAULT_USAGE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const FAILURE_MARKER = "subscription_usage_limit";

const SUBSCRIPTION_LABEL: Record<SubscriptionOAuthProvider, string> = {
  anthropic_claude_code: "Claude Code",
  openai_codex: "ChatGPT",
  meta_muse: "Muse Code",
};

export function subscriptionOAuthProviderFor(
  provider: string,
  keySource: ProviderKeySource,
): SubscriptionOAuthProvider | null {
  if (keySource !== "subscription") return null;
  if (provider === "anthropic") return "anthropic_claude_code";
  if (provider === "openai" || provider === "openai-codex") return "openai_codex";
  if (provider === "meta") return "meta_muse";
  return null;
}

/**
 * Recognize a personal subscription that has run out of quota. Claude Code
 * answers 429 with the unified rate-limit headers; the ChatGPT backend answers
 * 429 with a structured `error.code` and `resets_at`. Meta documents no
 * usage-limit signature for Muse Code plans, so any 429 on one holds it until
 * the reset Meta gives, if any. The Codex WebSocket
 * transport bypasses fetch, so its usage-limit error only survives as message
 * text and is matched there without a reset time.
 */
export function detectSubscriptionUsageLimit(args: {
  provider: string;
  keySource: ProviderKeySource;
  captured: CapturedProviderResponse | undefined;
  failure: Record<string, unknown>;
  now?: Date;
}): SubscriptionUsageLimit | null {
  const oauthProvider = subscriptionOAuthProviderFor(args.provider, args.keySource);
  if (oauthProvider === null) return null;
  const now = args.now ?? new Date();
  if (oauthProvider === "anthropic_claude_code") {
    return anthropicUsageLimit(args.captured, now);
  }
  if (oauthProvider === "meta_muse") return museUsageLimit(args.captured, now);
  return codexUsageLimit(args.captured, providerFailureMessage(args.failure), now);
}

function anthropicUsageLimit(
  captured: CapturedProviderResponse | undefined,
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
  return {
    oauthProvider: "anthropic_claude_code",
    resetsAt: resetFromUnixSeconds(captured.headers.get("anthropic-ratelimit-unified-reset"), now),
    reason: claim ? `Claude Code ${claim.replaceAll("_", " ")} usage limit reached.` : "Claude Code usage limit reached.",
  };
}

const CODEX_LIMIT_CODES = new Set(["usage_limit_reached", "usage_not_included"]);
const CODEX_LIMIT_MESSAGE = /usage_limit_reached|usage_not_included|hit your ChatGPT usage limit|the usage limit has been reached/i;

function codexUsageLimit(
  captured: CapturedProviderResponse | undefined,
  failureMessage: string,
  now: Date,
): SubscriptionUsageLimit | null {
  if (captured !== undefined && captured.status === 429) {
    const error = codexErrorBody(captured.bodyText);
    const code = typeof error?.code === "string" ? error.code : "";
    if (error !== null && (CODEX_LIMIT_CODES.has(code) || failureMessage.match(CODEX_LIMIT_MESSAGE))) {
      const plan = typeof error.plan_type === "string" ? ` (${error.plan_type.toLowerCase()} plan)` : "";
      return {
        oauthProvider: "openai_codex",
        resetsAt: laterReset(error.resets_at, captured.headers, now),
        reason: `ChatGPT usage limit reached${plan}.`,
      };
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

function museUsageLimit(
  captured: CapturedProviderResponse | undefined,
  now: Date,
): SubscriptionUsageLimit | null {
  if (captured === undefined || captured.status !== 429) return null;
  return {
    oauthProvider: "meta_muse",
    resetsAt: laterReset(codexErrorBody(captured.bodyText)?.resets_at, captured.headers, now),
    reason: "Muse Code usage limit reached.",
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
    ...(marker.switched === true ? { switched: true } : {}),
  };
}

export function subscriptionUsageLimitMessage(limit: SubscriptionUsageLimit): string {
  return `Your ${SUBSCRIPTION_LABEL[limit.oauthProvider]} subscription usage limit is reached. `
    + `It resets at ${limit.resetsAt.toISOString()}. `
    + "Mark it available early at https://app.dari.dev/credentials.";
}

export function subscriptionSwitchedMessage(limit: SubscriptionUsageLimit): string {
  const label = SUBSCRIPTION_LABEL[limit.oauthProvider];
  return `Your ${label} subscription usage limit is reached. `
    + `Dari switched to your next connected ${label} subscription; retry the request.`;
}

export function retryAfterSeconds(limit: SubscriptionUsageLimit, now = new Date()): number {
  return Math.max(0, Math.ceil((limit.resetsAt.getTime() - now.getTime()) / 1000));
}
