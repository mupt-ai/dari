import { afterEach, expect, test } from "bun:test";

import { RouterCoreError } from "../src/errors.js";
import {
  JEV_EVAL_RELEVANCE_BATCH_SIZE,
  JEV_EVAL_RELEVANCE_HISTORY_CHAR_BUDGET,
  JEV_EVAL_RELEVANCE_THRESHOLD,
  buildJevEvalRelevanceRequest,
  parseJevEvalRelevanceResponse,
  selectRelevantEvals,
  type JevEvalRelevanceRequest,
} from "../src/jev_eval_relevance.js";
import type { ChatMessage, RouterEval } from "../src/types.js";

const SWE: RouterEval = {
  id: "evl_swe",
  name: "SWE-bench Verified",
  description: "Asks agents to fix real software issues by editing existing repositories.",
  min_score: 0,
  max_score: 100,
  scores: [{ model_id: "openai/gpt-5.6-sol", score: 78 }],
};
const LEGAL: RouterEval = {
  id: "evl_legal",
  name: "LegalBench",
  description: null,
  min_score: 0,
  max_score: 100,
  scores: [{ model_id: "openai/gpt-5.6-sol", score: 60 }],
};
const DESIGN: RouterEval = {
  id: "evl_design",
  name: "DesignArena Website",
  min_score: 0,
  max_score: 2000,
  scores: [],
};

const STATE = {
  task: { role: "user", content: "Fix the failing auth tests." },
  conversation: [
    { role: "user", content: "Fix the failing auth tests." },
    { role: "assistant", content: "Running the suite." },
  ],
};

const CONFIG = {
  apiKey: "ts-key",
  endpoint: "https://api.typesafe.ai/v1",
  model: "jev-latest",
  timeoutMs: 5_000,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(relevance: Record<string, number>): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: Object.fromEntries(
      Object.entries(relevance).map(([id, noul]) => [id, { type: "noul", noul }]),
    ),
    usage: { input_tokens: 500, output_tokens: 30 },
  };
}

test("builds one noul question per card keyed by eval id over the task and conversation", () => {
  const request = buildJevEvalRelevanceRequest([SWE, LEGAL], STATE, "jev-latest");
  expect(request.model).toBe("jev-latest");
  expect(request.state).toEqual({ task: STATE.task, conversation: STATE.conversation });
  expect(Object.keys(request.questions)).toEqual(["evl_swe", "evl_legal"]);
  const swe = request.questions.evl_swe!;
  expect(swe.type).toBe("noul");
  expect(swe.criteria.true).toBeString();
  expect(swe.criteria.false).toBeString();
  expect(JSON.stringify(swe.instructions)).toContain("SWE-bench Verified");
  expect(JSON.stringify(swe.instructions)).toContain("editing existing repositories");
  // A card without a description asks on its name alone.
  expect(JSON.stringify(request.questions.evl_legal!.instructions)).not.toContain("description");
  // Scores never reach Jev: relevance is judged on what the benchmark
  // measures, not on who scores well.
  expect(JSON.stringify(request)).not.toContain("gpt-5.6-sol");
});

test("parses probabilities and keeps cards strictly above the threshold", () => {
  const parsed = parseJevEvalRelevanceResponse(
    response({ evl_swe: 0.31, evl_legal: 0.08, evl_design: JEV_EVAL_RELEVANCE_THRESHOLD }),
    [SWE, LEGAL, DESIGN],
  );
  expect(parsed.model).toBe("jev-1.13.0");
  expect(parsed.usage).toEqual({ input_tokens: 500, output_tokens: 30 });
  expect(parsed.cards).toEqual([
    { id: "evl_swe", name: "SWE-bench Verified", relevance: 0.31, kept: true },
    { id: "evl_legal", name: "LegalBench", relevance: 0.08, kept: false },
    { id: "evl_design", name: "DesignArena Website", relevance: 0.3, kept: false },
  ]);
});

test("rejects responses missing an answer, usage, or the noul shape", () => {
  const missing = () => parseJevEvalRelevanceResponse(response({ evl_swe: 0.9 }), [SWE, LEGAL]);
  expect(missing).toThrow(RouterCoreError);
  expect(missing).toThrow("invalid noul answer for evl_legal");
  expect(() =>
    parseJevEvalRelevanceResponse(
      { model: "jev", answers: { evl_swe: { type: "choice", choice: "yes" } }, usage: { input_tokens: 1, output_tokens: 1 } },
      [SWE],
    ),
  ).toThrow("invalid noul answer for evl_swe");
  expect(() =>
    parseJevEvalRelevanceResponse(
      response({ evl_swe: -0.1, evl_legal: 0.9 }),
      [SWE, LEGAL],
    ),
  ).toThrow("invalid noul answer for evl_swe");
  expect(() =>
    parseJevEvalRelevanceResponse(
      response({ evl_swe: 1.1, evl_legal: 0.9 }),
      [SWE, LEGAL],
    ),
  ).toThrow("invalid noul answer for evl_swe");
  expect(() =>
    parseJevEvalRelevanceResponse({ model: "jev", answers: { evl_swe: { type: "noul", noul: 0.9 } } }, [SWE]),
  ).toThrow("missing token usage");
  expect(() => parseJevEvalRelevanceResponse("nope", [SWE])).toThrow("unrecognized");
});

test("selectRelevantEvals asks Jev once, returns kept cards in order with telemetry", async () => {
  const bodies: JevEvalRelevanceRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ts-key");
    bodies.push(JSON.parse(String(init?.body)) as JevEvalRelevanceRequest);
    return Response.json(response({ evl_swe: 0.9, evl_legal: 0.1, evl_design: 0.7 }));
  }) as typeof fetch;

  const selection = await selectRelevantEvals([SWE, LEGAL, DESIGN, SWE], STATE, CONFIG);
  expect(bodies).toHaveLength(1);
  // Duplicate ids (router card also in the public catalog) are asked once.
  expect(Object.keys(bodies[0]!.questions)).toEqual(["evl_swe", "evl_legal", "evl_design"]);
  expect(selection.evals).toEqual([SWE, DESIGN]);
  expect(selection.cards.map((card) => [card.id, card.kept])).toEqual([
    ["evl_swe", true],
    ["evl_legal", false],
    ["evl_design", true],
  ]);
  expect(selection.model).toBe("jev-1.13.0");
  expect(selection.usage).toEqual({ input_tokens: 500, output_tokens: 30 });
  expect(selection.requests).toEqual(bodies);
});

test("selectRelevantEvals skips Jev entirely with no cards", async () => {
  globalThis.fetch = (async (_input: RequestInfo | URL): Promise<Response> => {
    throw new Error("must not call Jev");
  }) as typeof fetch;
  const selection = await selectRelevantEvals([], STATE, CONFIG);
  expect(selection.evals).toEqual([]);
  expect(selection.cards).toEqual([]);
  expect(selection.requests).toEqual([]);
});

test("selectRelevantEvals bounds long conversations without replacing the retained task", async () => {
  let request: JevEvalRelevanceRequest | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body)) as JevEvalRelevanceRequest;
    return Response.json(response({ evl_swe: 0.9 }));
  }) as typeof fetch;
  const task = { role: "user", content: "Original task" } as const;
  const conversation = [
    { role: "system", content: "System instructions" },
    task,
    ...Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "assistant" : "user",
      content: `Turn ${index}: ${"x".repeat(1_000)}`,
    })),
  ];

  await selectRelevantEvals([SWE], { task, conversation }, CONFIG);

  expect((request!.state as { task: unknown }).task).toEqual(task);
  const boundedConversation = (request!.state as { conversation: unknown[] }).conversation;
  // The history budget counts each message's JSON, not the array separators.
  const boundedChars = boundedConversation.reduce<number>(
    (total, message) => total + JSON.stringify(message).length,
    0,
  );
  expect(boundedChars).toBeLessThanOrEqual(
    JEV_EVAL_RELEVANCE_HISTORY_CHAR_BUDGET + JSON.stringify(conversation[0]).length,
  );
});

test("selectRelevantEvals caps a single large paste and long instructions", async () => {
  let request: JevEvalRelevanceRequest | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body)) as JevEvalRelevanceRequest;
    return Response.json(response({ evl_swe: 0.9 }));
  }) as typeof fetch;
  // Newlines and quotes double in JSON, so the cap must count escapes.
  const task = {
    role: "user",
    content: `Review this file:\n${'const x = "y";\n'.repeat(20_000)}`,
  } as const;

  await selectRelevantEvals([SWE], { task, conversation: [task] }, CONFIG);
  await selectRelevantEvals(
    [SWE],
    { task, conversation: [{ role: "system", content: "z".repeat(200_000) }, task] },
    CONFIG,
  );

  const state = request!.state as { task: { content: string }; conversation: unknown[] };
  expect(JSON.stringify(state.task).length).toBeLessThanOrEqual(2_000);
  expect(state.task.content.startsWith("Review this file:")).toBe(true);
  expect(state.task.content).toContain("router history truncated");
  expect(JSON.stringify(state.conversation).length).toBeLessThanOrEqual(
    2 * JEV_EVAL_RELEVANCE_HISTORY_CHAR_BUDGET,
  );
  expect(state.conversation.length).toBeGreaterThanOrEqual(2);
});

test("selectRelevantEvals keeps a short ask between long multipart harness text", async () => {
  let request: JevEvalRelevanceRequest | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body)) as JevEvalRelevanceRequest;
    return Response.json(response({ evl_swe: 0.9 }));
  }) as typeof fetch;
  const task: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: `<system-reminder>${"r".repeat(30_000)}</system-reminder>` },
      { type: "text", text: "Fix the failing auth tests." },
      { type: "text", text: `<env>${"e".repeat(30_000)}</env>` },
    ],
  };

  await selectRelevantEvals([SWE], { task, conversation: [task] }, CONFIG);

  const state = request!.state as { task: { content: string }; conversation: Array<{ content: string }> };
  expect(JSON.stringify(state.task).length).toBeLessThanOrEqual(2_000);
  expect(state.task.content).toContain("Fix the failing auth tests.");
  expect(state.conversation[0]!.content).toContain("Fix the failing auth tests.");
});

test("selectRelevantEvals batches large pools and sums usage", async () => {
  const cards: RouterEval[] = Array.from({ length: JEV_EVAL_RELEVANCE_BATCH_SIZE + 5 }, (_, index) => ({
    id: `evl_${index}`,
    name: `Bench ${index}`,
    min_score: 0,
    max_score: 100,
    scores: [],
  }));
  const sizes: number[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as JevEvalRelevanceRequest;
    const ids = Object.keys(body.questions);
    sizes.push(ids.length);
    return Response.json(
      response(Object.fromEntries(ids.map((id) => [id, id.endsWith("0") ? 0.9 : 0.2]))),
    );
  }) as typeof fetch;
  const selection = await selectRelevantEvals(cards, STATE, CONFIG);
  expect(sizes).toEqual([JEV_EVAL_RELEVANCE_BATCH_SIZE, 5]);
  expect(selection.evals.map((card) => card.id)).toEqual(
    cards.filter((card) => card.id.endsWith("0")).map((card) => card.id),
  );
  expect(selection.usage).toEqual({ input_tokens: 1_000, output_tokens: 60 });
});

test("selectRelevantEvals surfaces HTTP failures", async () => {
  globalThis.fetch = (async (_input: RequestInfo | URL) => new Response("bad key", { status: 401 })) as typeof fetch;
  const error = await selectRelevantEvals([SWE], STATE, CONFIG).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("401");
});
