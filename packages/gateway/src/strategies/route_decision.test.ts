import {
  resolveStrategyCandidates,
  type RoutingCandidate,
} from "@mupt-ai/dari-router/policy-engine";
import { expect, test } from "bun:test";

import type { ResolvedRouter } from "../types.js";
import { routeDecision } from "./route_decision.js";
import type { SelectorBackend } from "./routing.js";

const candidate: RoutingCandidate = {
  model: "openai/gpt-5.6-sol",
  reasoningEffort: "medium",
};

const selectorBackend: SelectorBackend = {
  selectorModel: "stub",
  contextWindowChars: async () => 100_000,
  select: async (args) => ({
    decision: {
      selectedModel: candidate.model,
      reasoningEffort: candidate.reasoningEffort,
      reason: "The router has only one compatible model/thinking-level pair.",
    },
    selectorModel: args.selectorModel,
    candidates: args.candidates,
    selectorInput: args.selectorInput,
    selectorRequest: args.selectorRequest,
    outputText: "",
    usage: { policy_bypassed: "single_candidate" },
    latencyMs: 1,
  }),
};

const credentials = {
  router_id: "rtr_test",
  organization_id: "org_test",
  api_key_id: null,
  attributed_user_id: null,
  enabled_models: [candidate.model],
  provider_keys: {},
  evals: [],
} as ResolvedRouter;

test("records when the selector policy is bypassed for one candidate", async () => {
  const routed = await routeDecision({
    selectorMessages: [{ role: "user", content: "hello" }],
    resolution: resolveStrategyCandidates({
      strategy: "dari",
      candidates: [candidate],
      costEstimates: [],
      modelPrices: {},
    }),
    credentials,
    conversationId: "conv_1",
    selectorBackend,
  });

  expect(routed.details).toEqual({ selector_policy_bypass: "single_candidate" });
});
