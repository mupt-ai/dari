/* The errors a Dari Link token gets, each with its own code so an app can
   tell its user what to do.

   401, the token itself is dead:
   - `link_token_expired`: refresh the access token (or mint a new child
     token) and retry.
   - `grant_revoked`: the grant is gone; `revoked_by` says who ended it
     (`user`, `app`, or `reuse_detected`) and `revoked_at` when. The user must
     link again.

   424, the grant's subscriptions cannot serve the request:
   - `subscription_exhausted`: the plans that can serve this client are at
     their usage limits; `resets_at` (and Retry-After) says when the first one
     is back, when that is known.
   - `grant_budget_exhausted`: the grant used the most tokens the user
     allowed it in a window (per five hours or per week), or every plan and
     key it shares is at its monthly spend limit; `resets_at` (and
     Retry-After) says when it serves again.
   - `subscription_client_mismatch`: the granted plans serve only another
     client (a Claude Code plan serves only Claude Code itself); the user must
     grant a plan that serves any app, such as a ChatGPT plan.
   - `model_not_granted`: no granted plan serves the model the request named,
     or any model the router lists. */

import { providerForModel } from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../http/errors.js";
import { subscriptionClient, subscriptionModelProvider } from "../models/subscriptions.js";
import type { ClientHarness, LinkUnavailable, ResolvedRouter, SubscriptionKind } from "../types.js";

export const LINK_GRANT_ERROR_CODES = [
  "subscription_exhausted",
  "grant_budget_exhausted",
  "subscription_client_mismatch",
  "model_not_granted",
] as const;

export type LinkGrantErrorCode = (typeof LINK_GRANT_ERROR_CODES)[number];

export const LINK_TOKEN_ERROR_CODES = ["link_token_expired", "grant_revoked"] as const;

/** Who ended a grant. */
export const LINK_REVOKERS = ["user", "app", "reuse_detected"] as const;

export type LinkRevoker = (typeof LINK_REVOKERS)[number];

export const SUBSCRIPTION_PLAN_LABELS: Record<SubscriptionKind, string> = {
  anthropic_claude_code: "Claude Pro/Max/Ultra",
  openai_codex: "ChatGPT Plus/Pro",
  meta_muse: "Meta Muse",
  opencode_go: "OpenCode Go",
  github_copilot: "GitHub Copilot",
  xai_grok: "Grok",
  vercel_token_pass: "Vercel Token Pass",
};

const ONLY_CLIENT: Partial<Record<SubscriptionKind, string>> = {
  anthropic_claude_code: "Claude Code itself",
  meta_muse: "Muse Code itself",
};

export function linkTokenExpired(): HttpError {
  return new HttpError(401, "This Dari Link token expired. Refresh it and retry.", "link_token_expired");
}

export function linkGrantRevoked(revokedBy: string | null, revokedAt: string | null): HttpError {
  const who = revokedBy === "user"
    ? "The user revoked this Dari Link grant."
    : revokedBy === "app"
      ? "The app revoked this Dari Link grant."
      : revokedBy === "reuse_detected"
        ? "This Dari Link grant was revoked because a rotated refresh token was used again."
        : "This Dari Link grant was revoked.";
  return new HttpError(401, `${who} The user must link again.`, "grant_revoked", undefined, undefined, {
    ...(revokedBy === null ? {} : { revoked_by: revokedBy }),
    ...(revokedAt === null ? {} : { revoked_at: revokedAt }),
  });
}

/** The granted plans for a provider are all at their usage limits. */
export function plansExhausted(plans: readonly SubscriptionKind[], resetsAt: Date | null): LinkUnavailable {
  const until = resetsAt === null ? "" : ` The first is back at ${resetsAt.toISOString()}.`;
  return {
    code: "subscription_exhausted",
    message: `The ${names(plans)} subscriptions this Dari Link grant may use are at their usage limits.${until}`,
    resets_at: resetsAt?.toISOString() ?? null,
  };
}

/** The grant used the most tokens the user allowed it in a window. */
export function budgetExhausted(resetsAt: Date): LinkUnavailable {
  return {
    code: "grant_budget_exhausted",
    message: `This Dari Link grant used the most tokens the user allowed this app. It is back at ${resetsAt.toISOString()}.`,
    resets_at: resetsAt.toISOString(),
  };
}

/** Every plan and key of the grant is at the monthly spend limit its user set. */
export function limitsReached(resetsAt: Date): LinkUnavailable {
  return {
    code: "grant_budget_exhausted",
    message: `Every plan and API key of this Dari Link grant is at the monthly spend limit the user set. It is back at ${resetsAt.toISOString()}.`,
    resets_at: resetsAt.toISOString(),
  };
}

/** The granted plans for a provider serve only another client. */
export function plansForAnotherClient(plans: readonly SubscriptionKind[]): LinkUnavailable {
  const only = [...new Set(plans.map((plan) => `${SUBSCRIPTION_PLAN_LABELS[plan]} plans serve only ${ONLY_CLIENT[plan] ?? "their own client"}`))];
  return {
    code: "subscription_client_mismatch",
    message: `This Dari Link grant cannot serve this client: ${only.join("; ")}. Ask the user to grant a plan that serves any app, such as a ChatGPT plan.`,
  };
}

/** A granted subscription, as a platform's resolve found it. */
export type LinkGrantedPlan = { kind: SubscriptionKind; unavailableUntil: Date | null };

/**
 * Why a grant serves nothing for each provider in `unserved` (the request
 * wanted it, the grant holds a plan for it, and no plan served): its plans
 * serve only another client, or are all at their usage limits. Every
 * platform's resolve says it this way.
 */
export function providersUnavailable(
  granted: readonly LinkGrantedPlan[],
  unserved: Iterable<string>,
  clientHarness: ClientHarness | undefined,
  now: Date,
): Record<string, LinkUnavailable> {
  const unavailable: Record<string, LinkUnavailable> = {};
  for (const provider of unserved) {
    const plans = granted.filter((plan) => subscriptionModelProvider(plan.kind) === provider);
    if (plans.length === 0) continue;
    const usable = plans.filter((plan) => {
      const client = subscriptionClient(plan.kind);
      return client === undefined || client === clientHarness;
    });
    if (usable.length === 0) {
      unavailable[provider] = plansForAnotherClient(plans.map((plan) => plan.kind));
      continue;
    }
    const held = usable.flatMap((plan) =>
      plan.unavailableUntil !== null && plan.unavailableUntil > now ? [plan.unavailableUntil] : []
    );
    unavailable[provider] = plansExhausted(
      usable.map((plan) => plan.kind),
      held.length === usable.length ? new Date(Math.min(...held.map((date) => date.getTime()))) : null,
    );
  }
  return unavailable;
}

/**
 * The error a grant that serves the request nothing gets: why its one pinned
 * model is not served, or why none is.
 */
export function linkNothingServed(
  unavailable: Record<string, LinkUnavailable>,
  pins: readonly { model: string }[] | null | undefined,
): HttpError {
  return pins?.length === 1
    ? modelNotServed({ link_unavailable: unavailable }, pins[0]!.model)
    : linkGrantUnavailableError(unavailable);
}

/**
 * Why a grant serves nothing at all: its plans are at their limits, serve
 * only another client, or serve no model.
 */
export function linkGrantUnavailableError(unavailable: Record<string, LinkUnavailable>): HttpError {
  const entries = Object.values(unavailable);
  const cause = entries.find((entry) => entry.code === "subscription_exhausted")
    ?? entries.find((entry) => entry.code === "subscription_client_mismatch");
  if (cause !== undefined) return linkUnavailableError(cause);
  return linkGrantError(
    "model_not_granted",
    "No subscription this Dari Link grant may use serves a model. GET /v1/link/grant shows the grant's plans and models.",
  );
}

/**
 * Why a grant cannot serve one model: its plan is at its limit or serves only
 * another client, or no granted plan serves the model at all.
 */
export function modelNotServed(
  credentials: Pick<ResolvedRouter, "link_unavailable">,
  modelId: string,
): HttpError {
  const cause = credentials.link_unavailable?.[modelId] ?? credentials.link_unavailable?.[providerForModel(modelId)];
  return cause === undefined ? modelNotGranted(modelId) : linkUnavailableError(cause);
}

export function modelNotGranted(modelId: string): HttpError {
  return linkGrantError(
    "model_not_granted",
    `Model '${modelId}' is not available on this Dari Link grant. GET /v1/link/grant lists the models it can use.`,
  );
}

export function linkUnavailableError(cause: LinkUnavailable): HttpError {
  const resetsAt = typeof cause.resets_at === "string" ? new Date(cause.resets_at) : null;
  return linkGrantError(cause.code, cause.message, resetsAt !== null && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null);
}

export function linkGrantError(code: LinkGrantErrorCode, message: string, resetsAt: Date | null = null): HttpError {
  if (resetsAt === null) return new HttpError(424, message, code);
  const retryAfter = Math.max(1, Math.ceil((resetsAt.getTime() - Date.now()) / 1000));
  return new HttpError(
    424,
    message,
    code,
    undefined,
    { "Retry-After": String(retryAfter) },
    { resets_at: resetsAt.toISOString() },
  );
}

function names(plans: readonly SubscriptionKind[]): string {
  return [...new Set(plans.map((plan) => SUBSCRIPTION_PLAN_LABELS[plan]))].join(" and ");
}
