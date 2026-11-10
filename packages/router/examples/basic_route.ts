// Deterministic end-to-end example: prepare a route, run a fake selector,
// finalize the decision. No network access, no credentials, no paid APIs —
// the "selector" here is a scripted stand-in for a real model call.
//
// Run with: bun run example   (or: bun run examples/basic_route.ts)

import {
  finalizeRoute,
  prepareRoute,
  type CandidateModelMetadata,
  type ModelPricing,
  type RouteInput,
} from "../src/policy-engine.js";

const FABLE = "anthropic/claude-fable-5-1";
const SOL = "openai/gpt-6.1-sol";
const DEEPSEEK = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

const metadata: Record<string, CandidateModelMetadata> = {
  [FABLE]: {
    provider: "anthropic",
    api: "anthropic-messages",
    supportsImageInput: true,
    supportsHostedWebSearch: false,
    supportsStructuredOutput: false,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  [SOL]: {
    provider: "openai",
    api: "openai-responses",
    supportsImageInput: true,
    supportsHostedWebSearch: true,
    supportsStructuredOutput: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  [DEEPSEEK]: {
    provider: "fireworks",
    api: "anthropic-messages",
    supportsImageInput: false,
    supportsHostedWebSearch: false,
    supportsStructuredOutput: true,
    supportedThinkingLevels: ["off", "high", "max"],
  },
};

// $/MTok rates from the provider model mappings; supply your own catalog in production.
const pricing: Record<string, ModelPricing> = {
  [FABLE]: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  [SOL]: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  [DEEPSEEK]: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
};

const input: RouteInput = {
  candidateModels: [FABLE, SOL, DEEPSEEK],
  metadataLookup: (modelId) => {
    const entry = metadata[modelId];
    if (!entry) throw new Error(`unknown model ${modelId}`);
    return entry;
  },
  requiredCapabilities: [],
  strategy: "dari",
  pricing: (model) => pricing[model] ?? null,
  // Keep the candidate list broad but the pairs manageable: pin each model to
  // a subset of its supported levels, as a router configuration would.
  modelThinkingLevels: {
    [FABLE]: ["high"],
    [SOL]: ["medium", "high"],
    [DEEPSEEK]: ["off", "high"],
  },
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Summarize the latest release notes." },
  ],
  // A fresh conversation: no fingerprint chains or warm-prefix hits yet. A
  // host would compute chains with prefixChain() and look hits up in its own
  // storage.
  chainsByModel: new Map([
    [FABLE, []],
    [SOL, []],
    [DEEPSEEK, []],
  ]),
  prefixHits: [],
  nowMs: Date.now(),
  toolChoiceFp: "",
  responseFormatFp: "",
  evals: [
    {
      id: "evl_swe",
      name: "SWE-bench Verified",
      min_score: 0,
      max_score: 100,
      scores: [
        { model_id: FABLE, score: 87, notes: "high row", thinking_level: "high" },
        { model_id: SOL, score: 78, notes: "generic row" },
        { model_id: DEEPSEEK, score: 64, notes: "high row", thinking_level: "high" },
      ],
    },
  ],
  selectorModel: "openai/gpt-6-luna",
  selectorContextWindowChars: 400_000,
};

const prepared = prepareRoute(input);
if (!prepared.selectorPreparation) throw new Error("selector preparation missing");

console.log("candidate pairs:", prepared.candidateResolution.candidates);
console.log(
  "cost estimates:",
  prepared.costEstimates.map((estimate) => ({
    model: estimate.model,
    reasoning_effort: estimate.reasoning_effort,
    est_prompt_tokens: estimate.est_prompt_tokens,
    est_input_cost_usd: estimate.est_input_cost_usd,
  })),
);

// A real host would POST selectorRequest to an OpenAI-compatible endpoint.
// This scripted selector always picks the cheapest viable pair.
const selectorOutput = JSON.stringify({
  selected_model: DEEPSEEK,
  reasoning_effort: "high",
  reason: "Simple summarization task; the cheapest candidate suffices.",
  fallback_model: SOL,
  fallback_reasoning_effort: "medium",
  fallback_reason: "Cross-provider fallback if the primary fails.",
});

const result = finalizeRoute(prepared, selectorOutput);
console.log("decision:", result.decision);
console.log("fallback:", result.fallbackDecision);
