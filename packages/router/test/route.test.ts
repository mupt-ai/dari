import { expect, test } from "bun:test";

import { RouterCoreError } from "../src/errors.js";
import { conversationPromptGrowth, finalizeRoute, prepareRoute, route, type RouteInput } from "../src/route.js";
import { DEFAULT_PROMPT_GROWTH_TOKENS_PER_TURN } from "../src/fixed_turn_cost_config.js";
import type { CandidateModelMetadata } from "../src/compatibility.js";
import type { ModelPricing } from "../src/cost.js";
import type { SelectorInput } from "../src/selector_input.js";

const MINI = "openai/gpt-4.1-mini";
const SONNET = "anthropic/claude-sonnet-4-6";

const METADATA: Record<string, CandidateModelMetadata> = {
  [MINI]: {
    provider: "openai",
    api: "openai-responses",
    supportsImageInput: true,
    supportsHostedWebSearch: true,
    supportsStructuredOutput: true,
    supportedThinkingLevels: ["medium"],
  },
  [SONNET]: {
    provider: "anthropic",
    api: "anthropic-messages",
    supportsImageInput: true,
    supportsHostedWebSearch: false,
    supportsStructuredOutput: false,
    supportedThinkingLevels: ["medium"],
  },
};

const PRICING: Record<string, ModelPricing> = {
  [MINI]: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  [SONNET]: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

const HIT_WRITTEN_AT = "2026-07-21T00:00:00Z";
const NOW_MS = Date.parse(HIT_WRITTEN_AT);

function routeInput(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    candidateModels: [MINI, SONNET],
    metadataLookup: (modelId) => {
      const metadata = METADATA[modelId];
      if (!metadata) throw new Error(`unexpected model ${modelId}`);
      return metadata;
    },
    requiredCapabilities: [],
    strategy: "dari",
    pricing: (model) => PRICING[model] ?? null,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Summarize the release notes." },
      { role: "assistant", content: "Which release?" },
      { role: "user", content: "The latest one." },
    ],
    chainsByModel: new Map([
      [MINI, ["mini-h1", "mini-h2"]],
      [SONNET, ["sonnet-h1", "sonnet-h2"]],
    ]),
    prefixHits: [
      {
        hash: "mini-h1",
        conversation_id: "conv_1",
        model: MINI,
        next_model: MINI,
        next_reasoning_effort: "medium",
        message_depth: 1,
        prompt_tokens: 2048,
        input_tokens: 2048,
        cache_read_tokens: 0,
        cache_write_tokens: 2048,
        tool_choice_fp: "fp-tools",
        response_format_fp: "fp-format",
        reasoning_bucket: "medium",
        reason: "warm incumbent",
        updated_at: HIT_WRITTEN_AT,
      },
    ],
    nowMs: NOW_MS,
    toolChoiceFp: "fp-tools",
    responseFormatFp: "fp-format",
    evals: [
      {
        id: "evl_1",
        name: "SWE-bench Verified",
        min_score: 0,
        max_score: 100,
        scores: [
          { model_id: MINI, score: 67, notes: "fast" },
          { model_id: SONNET, score: 81, notes: null, thinking_level: "medium" },
        ],
      },
    ],
    selectorModel: "selector/model",
    selectorContextWindowChars: 200_000,
    ...overrides,
  };
}

test("standard context limits exclude expensive candidates and their leases", () => {
  const prepared = prepareRoute(routeInput({
    promptTokenLimitFor: (model) => model === MINI ? 1 : null,
    previousDecision: { model: MINI, reasoningEffort: "medium", reason: "previous" },
  }));
  expect(prepared.candidateResolution.candidates.map((candidate) => candidate.model)).toEqual([SONNET]);
  expect(prepared.previousDecision).toBeUndefined();
  expect(prepared.costEstimates.map((estimate) => estimate.model)).toEqual([SONNET]);
});

test("standard context limits reject a request when no candidates fit", () => {
  expect(() => prepareRoute(routeInput({ promptTokenLimitFor: () => 1 }))).toThrow("standard-price context range");
});

test("standard context limits include the exact threshold", () => {
  const baseline = prepareRoute(routeInput());
  const limits = new Map(baseline.costEstimates.map((estimate) => [estimate.model, estimate.est_prompt_tokens]));
  const prepared = prepareRoute(routeInput({ promptTokenLimitFor: (model) => limits.get(model)! }));
  expect(prepared.candidateResolution.candidates).toEqual(baseline.candidateResolution.candidates);
});

test("context limits fail closed when prompt accounting fails", () => {
  expect(() => prepareRoute(routeInput({
    pricing: () => { throw new Error("unavailable"); },
    promptTokenLimitFor: () => 272_000,
  }))).toThrow("standard-price context range");
});

test("physical limits preserve unpriced fallback for models without surcharge limits", () => {
  const prepared = prepareRoute(routeInput({
    pricing: () => { throw new Error("unavailable"); },
    promptTokenLimitFor: () => 1_000_000,
    requiresPromptEstimateFor: (model) => model === MINI,
  }));
  expect(prepared.candidateResolution.candidates.map((candidate) => candidate.model)).toEqual([SONNET]);
});

test("prepareRoute recovers conversation state and builds the selector request", () => {
  const prepared = prepareRoute(routeInput());

  expect(prepared.warnings).toEqual([]);
  expect(prepared.conversationId).toBe("conv_1");
  expect(prepared.previousDecision).toEqual({
    model: MINI,
    reasoningEffort: "medium",
    reason: "warm incumbent",
  });
  expect(prepared.candidateResolution.candidates).toEqual([
    { model: MINI, reasoningEffort: "medium" },
    { model: SONNET, reasoningEffort: "medium" },
  ]);

  const estimateByModel = new Map(
    prepared.costEstimates.map((estimate) => [estimate.model, estimate]),
  );
  // The incumbent re-reads its warm prefix; the cold switch pays full price.
  expect(estimateByModel.get(MINI)?.warm_tokens).toBe(2048);
  expect(estimateByModel.get(SONNET)?.warm_tokens).toBe(0);

  const selectorPreparation = prepared.selectorPreparation;
  if (!selectorPreparation) throw new Error("expected a selector preparation");
  const input = selectorPreparation.selectorInput as SelectorInput;
  expect(input.candidate_pairs).toEqual([
    { model: MINI, thinking_level: "medium" },
    { model: SONNET, thinking_level: "medium" },
  ]);
  expect(input.previous_decision).toEqual({
    model: MINI,
    thinking_level: "medium",
    reason: "warm incumbent",
  });
  expect(input.imported_evals).toHaveLength(1);
  expect(selectorPreparation.selectorRequest.model).toBe("selector/model");
  expect(selectorPreparation.selectorRequest.reasoning_effort).toBe("off");
});

test("an unexpired lease surfaces only while its target is still a candidate", () => {
  const leasedHit = {
    ...routeInput().prefixHits![0]!,
    lease_turns_remaining: 4,
  };

  const prepared = prepareRoute(routeInput({ prefixHits: [leasedHit] }));
  expect(prepared.activeLease).toEqual({
    model: MINI,
    reasoningEffort: "medium",
    turnsRemaining: 4,
  });

  // An exhausted countdown means the lease expired: decide fresh.
  const expired = prepareRoute(
    routeInput({ prefixHits: [{ ...leasedHit, lease_turns_remaining: 0 }] }),
  );
  expect(expired.activeLease).toBeUndefined();

  // The leased target dropping out of the candidate set dissolves the lease.
  const narrowed = prepareRoute(
    routeInput({
      prefixHits: [leasedHit],
      candidateModels: [SONNET],
      chainsByModel: new Map([[SONNET, ["sonnet-h1", "sonnet-h2"]]]),
    }),
  );
  expect(narrowed.activeLease).toBeUndefined();
});

test("a trusted conversation id recovers a lease without claiming cache warmth", () => {
  const leasedHit = {
    ...routeInput().prefixHits![0]!,
    hash: "old-request-head",
    lease_turns_remaining: 4,
  };

  const prepared = prepareRoute(routeInput({
    conversationId: "conv_1",
    prefixHits: [leasedHit],
  }));

  expect(prepared.conversationId).toBe("conv_1");
  expect(prepared.identityMatchDepth).toBeNull();
  expect(prepared.activeLease).toEqual({
    model: MINI,
    reasoningEffort: "medium",
    turnsRemaining: 4,
  });
  expect(prepared.costEstimates.find(
    (estimate) => estimate.model === MINI,
  )?.warm_tokens).toBe(0);
});

test("a touched shallower row does not shadow the latest serving decision", () => {
  const base = routeInput().prefixHits![0]!;
  // A warm cache read bumps a shallower row's updated_at to the serving
  // turn's clock without rewriting its lease fields, so the touch shares the
  // newest clock with the turn's own deeper write.
  const touched = {
    ...base,
    hash: "old-shallow",
    message_depth: 1,
    lease_turns_remaining: 6,
    updated_at: HIT_WRITTEN_AT,
  };
  const served = {
    ...base,
    hash: "latest-deep",
    message_depth: 5,
    lease_turns_remaining: 2,
    updated_at: HIT_WRITTEN_AT,
  };

  // The deeper row at the newest clock carries the latest serving decision,
  // whichever order the host resolved the rows in.
  for (const prefixHits of [[touched, served], [served, touched]]) {
    const prepared = prepareRoute(routeInput({
      conversationId: "conv_1",
      prefixHits,
    }));
    expect(prepared.activeLease).toEqual({
      model: MINI,
      reasoningEffort: "medium",
      turnsRemaining: 2,
    });
    expect(prepared.identityMatchDepth).toBeNull();
  }
});

test("a matching old prefix cannot override the trusted conversation's adopted lease", () => {
  const base = routeInput().prefixHits![0]!;
  const expired = { ...base, lease_turns_remaining: 0 };
  const adopted = {
    ...base,
    hash: "rewritten-tail",
    message_depth: 5,
    next_model: SONNET,
    lease_turns_remaining: 4,
  };
  const unrelated = {
    ...adopted,
    conversation_id: "another-conversation",
    updated_at: "2026-07-21T00:00:01Z",
    lease_turns_remaining: 20,
  };
  for (const prefixHits of [[expired, adopted, unrelated], [unrelated, adopted, expired]]) {
    const prepared = prepareRoute(routeInput({ conversationId: "conv_1", prefixHits }));
    expect(prepared.identityMatchDepth).toBe(1);
    expect(prepared.previousDecision?.model).toBe(SONNET);
    expect(prepared.activeLease).toEqual({
      model: SONNET, reasoningEffort: "medium", turnsRemaining: 4,
    });
    expect(prepared.pendingLease).toBeUndefined();
    // The same history without a trusted identity must not inherit a branch's lease.
    expect(prepareRoute(routeInput({ prefixHits })).activeLease).toBeUndefined();
    // Exhaustion or invalidation of the latest lease must not revive an old one.
    for (const remaining of [0, undefined]) {
      expect(prepareRoute(routeInput({
        conversationId: "conv_1",
        prefixHits: [
          { ...expired, lease_turns_remaining: 8 },
          { ...adopted, lease_turns_remaining: remaining },
        ],
      })).activeLease).toBeUndefined();
    }
  }
});

test("a prefetched lease is recovered from any recent conversation row", () => {
  const base = routeInput().prefixHits![0]!;
  // The prefetch landed on a shallower row; a later turn appended the deeper
  // row without it.
  const stamped = {
    ...base,
    hash: "mini-h1",
    updated_at: HIT_WRITTEN_AT,
    pending_lease_model: MINI,
    pending_lease_reasoning_effort: "medium" as const,
    pending_lease_turns: 10,
    pending_lease_reason: "prefetched",
  };
  // The final hold turn writes a zero countdown; adoption keys on it.
  const deeper = {
    ...base,
    hash: "mini-h2",
    message_depth: 2,
    lease_turns_remaining: 0,
  };

  const prepared = prepareRoute(routeInput({ prefixHits: [stamped, deeper] }));
  expect(prepared.pendingLease).toEqual({
    model: MINI,
    reasoningEffort: "medium",
    turns: 10,
    reason: "prefetched",
    outputText: null,
  });

  // A pending lease whose pair is no longer a candidate dissolves.
  const narrowed = prepareRoute(
    routeInput({
      prefixHits: [{ ...stamped, pending_lease_model: "openai/gone" }, deeper],
    }),
  );
  expect(narrowed.pendingLease).toBeUndefined();

  // A fallback-served turn writes no countdown: the broken commitment must
  // not be resurrected by the stale prefetch on older rows.
  const broken = prepareRoute(
    routeInput({
      prefixHits: [stamped, { ...base, hash: "mini-h2", message_depth: 2 }],
    }),
  );
  expect(broken.pendingLease).toBeUndefined();
});

test("cross-model history uses the candidate's full provider-visible prompt", () => {
  const prepared = prepareRoute(routeInput({
    promptAccounting: {
      anchorSemantics: "matched_prefix",
      providerBlockDepthFor: () => 3,
      promptEstimateFor: (model, anchor) => ({
        chars: anchor
          ? new Map([
              [MINI, new Map([["mini-h1", 4]])],
              [SONNET, new Map([["sonnet-h1", 400]])],
            ]).get(model)?.get(anchor.hash) ?? 0
          : 400,
        reusesStoredPromptTokens: anchor !== undefined,
      }),
    },
  }));
  const estimateByModel = new Map(
    prepared.costEstimates.map((estimate) => [estimate.model, estimate]),
  );

  expect(estimateByModel.get(MINI)?.est_prompt_tokens).toBe(2049);
  expect(estimateByModel.get(SONNET)?.est_prompt_tokens).toBe(110);
});

test("stored input depth separates prompt accounting from output identity", () => {
  const baseHit = routeInput().prefixHits?.[0];
  if (!baseHit) throw new Error("expected prefix fixture");
  const prepared = prepareRoute(routeInput({
    prefixHits: [{
      ...baseHit,
      hash: "mini-h2",
      message_depth: 2,
      prompt_anchor_depth: 1,
      prompt_tokens: 100,
    }],
    promptAccounting: {
      anchorSemantics: "stored_input",
      providerBlockDepthFor: () => 3,
      promptEstimateFor: (_model, anchor) => ({
        chars: anchor?.hash === "mini-h1" ? 40_000 : 100_000,
        reusesStoredPromptTokens: anchor?.hash === "mini-h1",
      }),
    },
  }));
  const mini = prepared.costEstimates.find(
    (estimate) => estimate.model === MINI,
  );

  expect(mini?.est_prompt_tokens).toBe(10_100);
});

test("response format changes bypass stored prompt token anchors", () => {
  const anchorsByModel = new Map<string, string | undefined>();
  const prepared = prepareRoute(routeInput({
    responseFormatFp: "changed-format",
    promptAccounting: {
      anchorSemantics: "stored_input",
      providerBlockDepthFor: () => 3,
      promptEstimateFor: (model, anchor) => {
        anchorsByModel.set(model, anchor?.hash);
        return {
          chars: anchor ? 400 : 40_000,
          reusesStoredPromptTokens: anchor !== undefined,
        };
      },
    },
  }));
  const mini = prepared.costEstimates.find(
    (estimate) => estimate.model === MINI,
  );

  expect(anchorsByModel.get(MINI)).toBeUndefined();
  expect(mini?.warm_tokens).toBe(0);
  expect(mini?.est_prompt_tokens).toBe(10_000);
});

test("legacy output identity rows use a conservative full prompt estimate", () => {
  const baseHit = routeInput().prefixHits?.[0];
  if (!baseHit) throw new Error("expected prefix fixture");
  const prepared = prepareRoute(routeInput({
    prefixHits: [{
      ...baseHit,
      hash: "mini-h2",
      message_depth: 2,
      prompt_anchor_depth: null,
      prompt_tokens: 2_000,
    }],
    promptAccounting: {
      anchorSemantics: "stored_input",
      providerBlockDepthFor: () => 3,
      promptEstimateFor: (_model, anchor) => ({
        chars: anchor ? 40_000 : 100_000,
        reusesStoredPromptTokens: anchor !== undefined,
      }),
    },
  }));
  const mini = prepared.costEstimates.find(
    (estimate) => estimate.model === MINI,
  );

  expect(mini?.est_prompt_tokens).toBe(25_000);
  expect(mini?.warm_tokens).toBe(1_920);
});

test("legacy output identity rows price a fresh tail when full estimates undercut warmth", () => {
  const baseHit = routeInput().prefixHits?.[0];
  if (!baseHit) throw new Error("expected prefix fixture");
  const prepared = prepareRoute(routeInput({
    prefixHits: [{
      ...baseHit,
      hash: "mini-h2",
      message_depth: 2,
      prompt_anchor_depth: null,
      prompt_tokens: 2_000,
    }],
    promptAccounting: {
      anchorSemantics: "stored_input",
      providerBlockDepthFor: () => 3,
      promptEstimateFor: (_model, anchor) => ({
        chars: anchor ? 40_000 : 4_000,
        reusesStoredPromptTokens: anchor !== undefined,
      }),
    },
  }));
  const mini = prepared.costEstimates.find(
    (estimate) => estimate.model === MINI,
  );

  expect(mini?.est_prompt_tokens).toBe(2_920);
  expect(mini?.warm_tokens).toBe(1_920);
  expect(mini?.est_input_cost_usd).toBeCloseTo(0.000592, 12);
});

test("prepareCandidates preserves legacy messages and tailCharsFor inputs", () => {
  const prepared = prepareRoute(routeInput({
    promptAccounting: undefined,
    tailCharsFor: (model, hash) =>
      model === MINI && hash === "mini-h1" ? 40 : undefined,
  }));
  const estimateByModel = new Map(
    prepared.costEstimates.map((estimate) => [estimate.model, estimate]),
  );

  expect(estimateByModel.get(MINI)?.est_prompt_tokens).toBe(2058);
});

test("finalizeRoute validates the selector output against the candidates", () => {
  const prepared = prepareRoute(routeInput());
  const result = finalizeRoute(
    prepared,
    JSON.stringify({
      selected_model: MINI,
      reasoning_effort: "medium",
      reason: "warm and cheap",
      fallback_model: SONNET,
      fallback_reasoning_effort: "medium",
      fallback_reason: "cross-provider fallback",
    }),
  );
  expect(result.decision.selectedModel).toBe(MINI);
  expect(result.fallbackDecision?.selectedModel).toBe(SONNET);

  expect(() =>
    finalizeRoute(
      prepared,
      JSON.stringify({ selected_model: "openai/o3", reasoning_effort: "medium", reason: "x" }),
    ),
  ).toThrow("outside this router's candidates");
});

test("route runs the injected selector against the prepared request", async () => {
  const seen: unknown[] = [];
  const result = await route(routeInput(), {
    select: async (request) => {
      seen.push(request);
      return JSON.stringify({
        selected_model: MINI,
        reasoning_effort: "medium",
        reason: "warm incumbent continues",
        fallback_model: SONNET,
        fallback_reasoning_effort: "medium",
        fallback_reason: "different provider",
      });
    },
  });

  expect(seen).toHaveLength(1);
  expect(result.decision).toEqual({
    selectedModel: MINI,
    reasoningEffort: "medium",
    reason: "warm incumbent continues",
  });
  expect(result.prepared.candidateResolution.pruning).not.toBeNull();
});

test("structured output requirements narrow candidates before selection", () => {
  const prepared = prepareRoute(routeInput({ requiredCapabilities: ["structured_output"] }));
  expect(prepared.candidateResolution.candidates).toEqual([
    { model: MINI, reasoningEffort: "medium" },
  ]);
});

test("a custom strategy without configuration yields no selector preparation", async () => {
  const input = routeInput({ strategy: "custom", customConfig: null });
  const prepared = prepareRoute(input);
  expect(prepared.selectorPreparation).toBeNull();

  await expect(
    route(input, { select: async () => "" }),
  ).rejects.toThrow(RouterCoreError);
});

test("cost estimation failures degrade to warnings instead of failing the route", () => {
  const prepared = prepareRoute(
    routeInput({
      pricing: () => {
        throw new Error("pricing backend exploded");
      },
    }),
  );
  expect(prepared.warnings).toHaveLength(1);
  expect(prepared.warnings[0]?.phase).toBe("cost_estimation");
  expect(prepared.costEstimates).toEqual([]);
  expect(prepared.candidateResolution.candidates).toHaveLength(2);
});

// A hit past the cache-warmth window still names the conversation: identity
// hits recover the id and previous decision, but never feed cost estimation.
test("stale identity hits recover the conversation without claiming warmth", () => {
  const prepared = prepareRoute(
    routeInput({ nowMs: NOW_MS + 10 * 60 * 1000 }),
  );

  expect(prepared.conversationId).toBe("conv_1");
  expect(prepared.identityMatchDepth).toBe(1);
  expect(prepared.previousDecision).toEqual({
    model: MINI,
    reasoningEffort: "medium",
    reason: "warm incumbent",
  });
  for (const estimate of prepared.costEstimates) {
    expect(estimate.warm_tokens).toBe(0);
  }
});

// An echo-mutating client misses every strict chain but still matches the
// loose tier; identity survives while the cache is correctly treated cold.
test("loose-tier matches recover the conversation when strict chains miss", () => {
  const looseHit = {
    ...routeInput().prefixHits![0]!,
    hash: "hash-not-in-any-chain",
    loose_hash: "loose-h2",
    conversation_id: "conv_loose",
  };
  const prepared = prepareRoute(
    routeInput({
      prefixHits: [looseHit],
      looseChain: ["loose-h1", "loose-h2"],
    }),
  );

  expect(prepared.conversationId).toBe("conv_loose");
  expect(prepared.identityMatchDepth).toBe(2);
  for (const estimate of prepared.costEstimates) {
    expect(estimate.warm_tokens).toBe(0);
  }
});

// When both tiers match different entries, the deepest position wins —
// depth measures how much of the conversation the entry accounts for.
test("the deepest identity hit wins across hash tiers", () => {
  const shallowStrict = routeInput().prefixHits![0]!; // depth 1 on MINI chain
  const deepLoose = {
    ...shallowStrict,
    hash: "hash-not-in-any-chain",
    loose_hash: "loose-h3",
    conversation_id: "conv_deep",
    reason: "deeper continuation",
  };
  const prepared = prepareRoute(
    routeInput({
      prefixHits: [shallowStrict, deepLoose],
      looseChain: ["loose-h1", "loose-h2", "loose-h3"],
    }),
  );

  expect(prepared.conversationId).toBe("conv_deep");
  expect(prepared.identityMatchDepth).toBe(3);
});

// Loose hashes are non-unique: transcript twins can collide at equal depth.
// The pick must be deterministic and principled — a strict (byte-identical)
// match beats a loose-only one, and among loose-only twins the most recently
// active entry wins, regardless of result-set order.
test("equal-depth identity ties prefer strict matches, then recency", () => {
  const base = routeInput().prefixHits![0]!;
  const strictHit = {
    ...base,
    conversation_id: "conv_strict",
    updated_at: "2026-07-21T00:00:00Z",
  }; // matches MINI chain at depth 1
  const looseTwin = {
    ...base,
    hash: "hash-not-in-any-chain",
    loose_hash: "loose-h1",
    conversation_id: "conv_loose_twin",
    updated_at: "2026-07-21T00:05:00Z",
  }; // loose depth 1, newer — but strict must still win
  for (const order of [[strictHit, looseTwin], [looseTwin, strictHit]]) {
    const prepared = prepareRoute(
      routeInput({
        prefixHits: order,
        looseChain: ["loose-h1"],
      }),
    );
    expect(prepared.conversationId).toBe("conv_strict");
  }

  const olderTwin = {
    ...looseTwin,
    conversation_id: "conv_older_twin",
    updated_at: "2026-07-21T00:01:00Z",
  };
  for (const order of [[looseTwin, olderTwin], [olderTwin, looseTwin]]) {
    const prepared = prepareRoute(
      routeInput({
        prefixHits: order,
        looseChain: ["loose-h1"],
      }),
    );
    expect(prepared.conversationId).toBe("conv_loose_twin");
  }
});

test("projected prompt growth comes from the conversation's own prefix rows", () => {
  const row = (conversation_id: string, message_depth: number, prompt_tokens: number) => ({
    hash: `h${message_depth}`,
    conversation_id,
    model: MINI,
    message_depth,
    prompt_tokens,
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    tool_choice_fp: "",
    response_format_fp: "",
    reason: "turn",
    updated_at: new Date().toISOString(),
  });
  const rows = [
    row("c-1", 2, 4000),
    row("c-1", 4, 5500),
    row("c-1", 6, 7000),
    row("c-1", 6, 6900),
    row("c-other", 8, 90_000),
  ];
  expect(conversationPromptGrowth(rows, "c-1")).toBe(1500);
  // Too little history, or no conversation, falls back to the default.
  expect(conversationPromptGrowth(rows.slice(0, 2), "c-1")).toBe(DEFAULT_PROMPT_GROWTH_TOKENS_PER_TURN);
  expect(conversationPromptGrowth(rows, null)).toBe(DEFAULT_PROMPT_GROWTH_TOKENS_PER_TURN);
});
