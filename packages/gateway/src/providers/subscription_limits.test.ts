import { describe, expect, test } from "bun:test";

import {
  DEFAULT_USAGE_LIMIT_WINDOW_MS,
  codexUsageLimitError,
  detectSubscriptionUsageLimit,
  failureWithSubscriptionUsageLimit,
  retryAfterSeconds,
  subscriptionUsageLimitFromFailure,
  subscriptionSwitchedMessage,
  subscriptionUsageLimitMessage,
  subscriptionUsageFromHeaders,
} from "./subscription_limits.js";
import { createProviderResponseCapture, type CapturedProviderResponse } from "./response_capture.js";

const NOW = new Date("2026-09-19T12:00:00Z");
const RESET_SECONDS = Math.floor(NOW.getTime() / 1000) + 3600 * 3;
const FAILURE = { stopReason: "error", errorMessage: "429 rate limit" };

const MODEL = "anthropic/claude-fable-5";

// Every case but the per-model ones routes the same model.
function detectLimit(args: Omit<Parameters<typeof detectSubscriptionUsageLimit>[0], "model"> & { model?: string }) {
  return detectSubscriptionUsageLimit({ model: MODEL, ...args });
}

function captured(status: number, headers: Record<string, string>, body = ""): CapturedProviderResponse {
  return { status, headers: new Headers(headers), bodyText: body };
}

describe("detectSubscriptionUsageLimit", () => {
  test("ignores router-owned keys", () => {
    expect(detectLimit({
      provider: "anthropic",
      keySource: "user",
      captured: captured(429, { "anthropic-ratelimit-unified-status": "rejected" }),
      failure: FAILURE,
      now: NOW,
    })).toBeNull();
  });

  test("recognizes a rejected Claude Code unified window with its reset time", () => {
    const limit = detectLimit({
      provider: "anthropic",
      keySource: "subscription",
      captured: captured(429, {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(RESET_SECONDS),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      }),
      failure: FAILURE,
      now: NOW,
    });
    expect(limit).toEqual({
      oauthProvider: "anthropic_claude_code",
      resetsAt: new Date(RESET_SECONDS * 1000),
      reason: "Claude Code five hour usage limit reached.",
    });
  });

  test("treats an Anthropic 429 without a rejected unified status as transient", () => {
    expect(detectLimit({
      provider: "anthropic",
      keySource: "subscription",
      captured: captured(429, { "anthropic-ratelimit-unified-status": "allowed" }),
      failure: FAILURE,
      now: NOW,
    })).toBeNull();
    expect(detectLimit({
      provider: "anthropic",
      keySource: "subscription",
      captured: captured(529, { "anthropic-ratelimit-unified-status": "rejected" }),
      failure: FAILURE,
      now: NOW,
    })).toBeNull();
  });

  test("falls back to the default window when Anthropic omits the reset", () => {
    const limit = detectLimit({
      provider: "anthropic",
      keySource: "subscription",
      captured: captured(429, { "anthropic-ratelimit-unified-status": "rejected" }),
      failure: FAILURE,
      now: NOW,
    });
    expect(limit?.resetsAt).toEqual(new Date(NOW.getTime() + DEFAULT_USAGE_LIMIT_WINDOW_MS));
  });

  test("recognizes the ChatGPT usage-limit body over SSE", () => {
    const limit = detectLimit({
      provider: "openai-codex",
      keySource: "subscription",
      captured: captured(429, {}, JSON.stringify({
        error: {
          code: "usage_limit_reached",
          message: "You've hit your usage limit.",
          plan_type: "Plus",
          resets_at: RESET_SECONDS,
        },
      })),
      failure: { stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit (plus plan)." },
      now: NOW,
    });
    expect(limit).toEqual({
      oauthProvider: "openai_codex",
      resetsAt: new Date(RESET_SECONDS * 1000),
      reason: "ChatGPT usage limit reached (plus plan).",
    });
  });

  test("holds a ChatGPT plan until the later of resets_at and Retry-After", () => {
    const limitBody = JSON.stringify({ error: { code: "usage_limit_reached", resets_at: RESET_SECONDS } });
    const detect = (headers: Record<string, string>) => detectLimit({
      provider: "openai-codex",
      keySource: "subscription",
      captured: captured(429, headers, limitBody),
      failure: FAILURE,
      now: NOW,
    })?.resetsAt;

    // Retry-After in seconds, past resets_at.
    expect(detect({ "retry-after": String(3600 * 5) })).toEqual(new Date(NOW.getTime() + 3600 * 5 * 1000));
    // Retry-After as an HTTP date, before resets_at.
    expect(detect({ "retry-after": new Date(NOW.getTime() + 60_000).toUTCString() })).toEqual(
      new Date(RESET_SECONDS * 1000),
    );
    expect(detect({ "retry-after-ms": String(3600 * 4 * 1000) })).toEqual(new Date(NOW.getTime() + 3600 * 4 * 1000));
    // Only Retry-After present.
    expect(detectLimit({
      provider: "openai-codex",
      keySource: "subscription",
      captured: captured(429, { "retry-after": "120" }, JSON.stringify({ error: { code: "usage_limit_reached" } })),
      failure: FAILURE,
      now: NOW,
    })?.resetsAt).toEqual(new Date(NOW.getTime() + 120_000));
  });

  test("ignores a Codex 429 that is not a plan limit", () => {
    expect(detectLimit({
      provider: "openai-codex",
      keySource: "subscription",
      captured: captured(429, {}, JSON.stringify({ error: { code: "slow_down", message: "Too many requests" } })),
      failure: { stopReason: "error", errorMessage: "Too many requests" },
      now: NOW,
    })).toBeNull();
    // A ChatGPT per-minute 429 is transient; holding the subscription would
    // skip a still-valid plan until Mark Available or the default hour.
    expect(detectLimit({
      provider: "openai-codex",
      keySource: "subscription",
      captured: captured(429, {}, JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Too many requests" } })),
      failure: { stopReason: "error", errorMessage: "Too many requests" },
      now: NOW,
    })).toBeNull();
  });

  test("holds a Muse Code plan on a 429 until Meta's reset, or for the default window", () => {
    const withReset = detectLimit({
      provider: "meta",
      keySource: "subscription",
      captured: captured(429, {}, JSON.stringify({ error: { code: "rate_limit_exceeded", resets_at: RESET_SECONDS } })),
      failure: FAILURE,
      now: NOW,
    });
    expect(withReset).toEqual({
      oauthProvider: "meta_muse",
      resetsAt: new Date(RESET_SECONDS * 1000),
      reason: "Muse Code usage limit reached.",
    });
    const retryAfter = detectLimit({
      provider: "meta",
      keySource: "subscription",
      captured: captured(429, { "retry-after": "120" }, "{}"),
      failure: FAILURE,
      now: NOW,
    });
    expect(retryAfter?.resetsAt).toEqual(new Date(NOW.getTime() + 120_000));
    const bare = detectLimit({
      provider: "meta",
      keySource: "subscription",
      captured: captured(429, {}, "not json"),
      failure: FAILURE,
      now: NOW,
    });
    expect(bare?.resetsAt).toEqual(new Date(NOW.getTime() + DEFAULT_USAGE_LIMIT_WINDOW_MS));
    expect(subscriptionUsageLimitMessage(bare!)).toStartWith("Your Muse Code subscription usage limit is reached.");
    expect(subscriptionUsageLimitFromFailure(failureWithSubscriptionUsageLimit({}, bare!))).toEqual(bare);
  });

  test("a Meta API key or a non-429 failure is not a plan limit", () => {
    for (const [keySource, status] of [["user", 429], ["subscription", 500]] as const) {
      expect(detectLimit({
        provider: "meta",
        keySource,
        captured: captured(status, {}, "{}"),
        failure: FAILURE,
        now: NOW,
      })).toBeNull();
    }
  });

  test("recognizes the Codex WebSocket usage-limit error from its message alone", () => {
    const limit = detectLimit({
      provider: "openai-codex",
      keySource: "subscription",
      captured: undefined,
      failure: { stopReason: "error", errorMessage: "Codex error: usage_limit_reached" },
      now: NOW,
    });
    expect(limit).toEqual({
      oauthProvider: "openai_codex",
      resetsAt: new Date(NOW.getTime() + DEFAULT_USAGE_LIMIT_WINDOW_MS),
      reason: "ChatGPT usage limit reached.",
    });
  });

  test("recognizes the production Codex 502 message after stream normalization", () => {
    const limit = detectLimit({
      provider: "openai-codex",
      keySource: "subscription",
      captured: captured(502, {}, "Bad Gateway"),
      failure: {
        stopReason: "error",
        errorMessage: "Codex error: The usage limit has been reached",
        content: [],
      },
      now: NOW,
    });
    expect(limit).toEqual({
      oauthProvider: "openai_codex",
      resetsAt: new Date(NOW.getTime() + DEFAULT_USAGE_LIMIT_WINDOW_MS),
      reason: "ChatGPT usage limit reached.",
    });
  });
});

// A plan can cap one model family on its own; only that model leaves routing.
describe("per-model usage limits", () => {
  const anthropic = (headers: Record<string, string>) => detectLimit({
    provider: "anthropic",
    keySource: "subscription",
    captured: captured(429, {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(RESET_SECONDS),
      ...headers,
    }),
    failure: FAILURE,
    now: NOW,
  });

  test("a Claude Code model-family window holds only the routed model", () => {
    expect(anthropic({ "anthropic-ratelimit-unified-representative-claim": "seven_day_opus" })).toEqual({
      oauthProvider: "anthropic_claude_code",
      resetsAt: new Date(RESET_SECONDS * 1000),
      reason: "Claude Code seven day opus usage limit reached.",
      model: MODEL,
    });
    expect(anthropic({ "anthropic-ratelimit-unified-representative-claim": "seven_day_fable" })?.model).toBe(MODEL);
    // The limiter offering a fallback model means the plan itself has room.
    expect(anthropic({ "anthropic-ratelimit-unified-fallback": "available" })).toMatchObject({
      model: MODEL,
      reason: `Claude Code usage limit for ${MODEL} reached.`,
    });
  });

  test("plan-wide Claude Code windows still hold the whole plan", () => {
    for (const claim of ["five_hour", "seven_day", "seven_day_overage_included", "seven_day_oauth_apps"]) {
      expect(anthropic({ "anthropic-ratelimit-unified-representative-claim": claim })?.model).toBeUndefined();
    }
  });

  test("a ChatGPT refusal with only another limit family spent holds only the routed model", () => {
    const body = JSON.stringify({ error: { code: "usage_limit_reached", resets_at: RESET_SECONDS } });
    const codex = (headers: Record<string, string>) => detectLimit({
      provider: "openai-codex",
      keySource: "subscription",
      model: "openai/gpt-5.3-codex-spark",
      captured: captured(429, headers, body),
      failure: FAILURE,
      now: NOW,
    });
    expect(codex({
      "x-codex-primary-used-percent": "40",
      "x-codex-bengalfox-primary-used-percent": "100",
    })).toEqual({
      oauthProvider: "openai_codex",
      resetsAt: new Date(RESET_SECONDS * 1000),
      reason: "ChatGPT usage limit for openai/gpt-5.3-codex-spark reached.",
      model: "openai/gpt-5.3-codex-spark",
    });
    // The plan's own family spent is the plan's limit, whatever else is.
    expect(codex({
      "x-codex-secondary-used-percent": "100",
      "x-codex-bengalfox-primary-used-percent": "100",
    })?.model).toBeUndefined();
    expect(codex({})?.model).toBeUndefined();
  });

  test("a model limit tells the client the retry routes elsewhere, not to buy a plan", () => {
    const limit = {
      oauthProvider: "openai_codex" as const,
      resetsAt: new Date(RESET_SECONDS * 1000),
      reason: "ChatGPT usage limit for openai/gpt-5.3-codex-spark reached.",
      model: "openai/gpt-5.3-codex-spark",
      switched: true,
    };
    expect(subscriptionUsageLimitFromFailure(failureWithSubscriptionUsageLimit(FAILURE, limit))).toEqual(limit);
    expect(subscriptionSwitchedMessage(limit)).toBe(
      "Your ChatGPT subscription usage limit for openai/gpt-5.3-codex-spark is reached; it resets at "
        + `${limit.resetsAt.toISOString()}. Dari routes to other models until then; retry the request.`,
    );
    // Codex would render its own notice as if the whole plan were spent.
    expect(codexUsageLimitError(limit)).toBeNull();
    expect(subscriptionUsageLimitMessage(limit)).toStartWith(
      "Your ChatGPT subscription usage limit for openai/gpt-5.3-codex-spark is reached.",
    );
  });
});

test("the failure marker round-trips through the provider message", () => {
  const limit = {
    oauthProvider: "anthropic_claude_code" as const,
    resetsAt: new Date(RESET_SECONDS * 1000),
    reason: "Claude Code five hour usage limit reached.",
  };
  const tagged = failureWithSubscriptionUsageLimit(FAILURE, limit);
  expect(tagged.errorMessage).toBe(FAILURE.errorMessage);
  expect(subscriptionUsageLimitFromFailure(tagged)).toEqual(limit);
  expect(subscriptionUsageLimitFromFailure(FAILURE)).toBeNull();
  const hosted = subscriptionUsageLimitMessage(limit, "https://app.dari.dev/credentials");
  expect(hosted).toContain("Claude Code subscription usage limit is reached");
  expect(hosted).toContain(limit.resetsAt.toISOString());
  expect(hosted).toContain("add another Claude Code subscription at https://app.dari.dev/credentials?buy=anthropic_claude_code.");
  // A self-hosted gateway has no web page; `dari accounts` manages its plans.
  expect(subscriptionUsageLimitMessage(limit)).toEndWith(
    "To keep going now, add another Claude Code subscription or mark this one available early with `dari accounts`.",
  );
  expect(retryAfterSeconds(limit, NOW)).toBe(3600 * 3);
  const switched = { ...limit, switched: true };
  expect(subscriptionUsageLimitFromFailure(failureWithSubscriptionUsageLimit(FAILURE, switched))).toEqual(switched);
  expect(subscriptionSwitchedMessage(limit)).toBe(
    "Your Claude Code subscription usage limit is reached. "
      + "Dari switched to your next connected Claude Code subscription; retry the request.",
  );
});

// Claude Code's unified limiter reports each window on every response; the
// tightest window is the one that decides when the plan runs out.
describe("subscriptionUsageFromHeaders", () => {
  const FIVE_HOUR_RESET = Math.floor(NOW.getTime() / 1000) + 3600;
  const WEEK_RESET = Math.floor(NOW.getTime() / 1000) + 3 * 86_400;
  const headers = (values: Record<string, string>) => new Headers(values);

  test("reports the window closest to its limit", () => {
    expect(subscriptionUsageFromHeaders("anthropic", "subscription", headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": String(FIVE_HOUR_RESET),
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.81",
      "anthropic-ratelimit-unified-7d-reset": String(WEEK_RESET),
      "anthropic-ratelimit-unified-7d-status": "allowed_warning",
    }), NOW)).toEqual({
      utilization: 0.81,
      resetsAt: new Date(WEEK_RESET * 1000),
      windows: [
        { minutes: 300, utilization: 0.42, resetsAt: new Date(FIVE_HOUR_RESET * 1000) },
        { minutes: 10_080, utilization: 0.81, resetsAt: new Date(WEEK_RESET * 1000) },
      ],
    });
  });

  test("clamps out-of-range values and skips windows without a future reset", () => {
    expect(subscriptionUsageFromHeaders("anthropic", "subscription", headers({
      "anthropic-ratelimit-unified-5h-utilization": "1.7",
      "anthropic-ratelimit-unified-5h-reset": String(FIVE_HOUR_RESET),
      "anthropic-ratelimit-unified-7d-utilization": "0.99",
      "anthropic-ratelimit-unified-7d-reset": String(Math.floor(NOW.getTime() / 1000) - 60),
    }), NOW)).toEqual({
      utilization: 1,
      resetsAt: new Date(FIVE_HOUR_RESET * 1000),
      windows: [{ minutes: 300, utilization: 1, resetsAt: new Date(FIVE_HOUR_RESET * 1000) }],
    });
  });

  test("reads a ChatGPT plan's Codex windows as a fraction used", () => {
    expect(subscriptionUsageFromHeaders("openai", "subscription", headers({
      "x-codex-primary-used-percent": "37.5",
      "x-codex-primary-reset-at": String(FIVE_HOUR_RESET),
      "x-codex-secondary-used-percent": "12",
      "x-codex-secondary-reset-at": String(WEEK_RESET),
      "x-codex-secondary-window-minutes": "43200",
    }), NOW)).toEqual({
      utilization: 0.375,
      resetsAt: new Date(FIVE_HOUR_RESET * 1000),
      windows: [
        { minutes: 300, utilization: 0.375, resetsAt: new Date(FIVE_HOUR_RESET * 1000) },
        { minutes: 43_200, utilization: 0.12, resetsAt: new Date(WEEK_RESET * 1000) },
      ],
    });
  });

  test("reports nothing for API keys, other plans, or responses without usage", () => {
    const usage = headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
      "anthropic-ratelimit-unified-5h-reset": String(FIVE_HOUR_RESET),
    });
    expect(subscriptionUsageFromHeaders("anthropic", "user", usage, NOW)).toBeNull();
    expect(subscriptionUsageFromHeaders("openai", "subscription", usage, NOW)).toBeNull();
    expect(subscriptionUsageFromHeaders("anthropic", "subscription", headers({}), NOW)).toBeNull();
  });
});

test("the response capture remembers rejected responses and leaves the body readable", async () => {
  const capture = createProviderResponseCapture();
  const originalFetch = globalThis.fetch;
  const responses = [
    new Response("ok", { status: 200 }),
    new Response(JSON.stringify({ error: { code: "usage_limit_reached" } }), {
      status: 429,
      headers: { "x-test": "1" },
    }),
  ];
  globalThis.fetch = (async () => responses.shift()!) as unknown as typeof globalThis.fetch;
  try {
    const served = await capture.fetch("https://provider.test/a");
    expect(capture.last).toBeUndefined();
    // A served response's headers are kept for the plan's reported usage.
    expect(capture.succeeded).toBe(served.headers);
    const rejected = await capture.fetch("https://provider.test/b");
    expect(await rejected.text()).toContain("usage_limit_reached");
    expect(capture.last?.status).toBe(429);
    expect(capture.last?.headers.get("x-test")).toBe("1");
    expect(capture.last?.bodyText).toContain("usage_limit_reached");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an exhausted ChatGPT plan answers in the shape Codex shows, with how to add another", () => {
  const limit = { oauthProvider: "openai_codex" as const, resetsAt: new Date(RESET_SECONDS * 1000), reason: "ChatGPT usage limit reached." };
  expect(codexUsageLimitError(limit, "https://app.dari.dev/credentials")).toEqual({
    body: { type: "usage_limit_reached", resets_at: RESET_SECONDS },
    headers: { "x-codex-promo-message": "Add another ChatGPT subscription at https://app.dari.dev/credentials?buy=openai_codex" },
  });
  expect(codexUsageLimitError(limit)?.headers).toEqual({
    "x-codex-promo-message": "Add another ChatGPT subscription with `dari accounts`",
  });
  expect(codexUsageLimitError({ ...limit, oauthProvider: "anthropic_claude_code" })).toBeNull();
});
