import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import type { RequestRecord, SessionPin } from "../platform/platform.js";
import type { SelectorBackend } from "../strategies/routing.js";
import { testPlatform } from "../test_support/platform.js";
import type { ResolvedRouter } from "../types.js";
import { createRequestHandler } from "./handler.js";

// Session pinning end to end through the real handler: a rotating selector
// would move every turn, so any turn served without a selector call proves
// the pin held, and every fresh agent proves it was routed on its own.
const MODEL_A = "openrouter/acme/model-a";
const MODEL_B = "openrouter/acme/model-b";
const MODEL_C = "openrouter/acme/model-c";
const MAIN_SESSION = "4b1f0c3e-2a6d-4e8f-9b7a-1c2d3e4f5a6b";
const SUBAGENT_THREAD = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const pins = new Map<string, SessionPin>();
const records: RequestRecord[] = [];
let selections = 0;
let selectedEfforts: string[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let handler: (request: Request) => Promise<Response>;
let router: ResolvedRouter;

// Picks the next candidate on every call and asks for a lease, which a
// pinned session must ignore.
const rotatingSelector: SelectorBackend = {
  selectorModel: "test/rotating",
  contextWindowChars: async () => 1_000_000,
  prepareMessages: () => [],
  supportsSpeculativeRouting: false,
  select: async (args) => {
    const candidate = args.candidates[selections % args.candidates.length]!;
    selections += 1;
    selectedEfforts = args.candidates.map((candidate) => candidate.reasoningEffort);
    return {
      decision: {
        selectedModel: candidate.model,
        reasoningEffort: candidate.reasoningEffort,
        reason: "Rotating test selection.",
        leaseTurnsRemaining: 9,
      },
      selectorModel: args.selectorModel,
      candidates: args.candidates,
      selectorInput: args.selectorInput,
      selectorRequest: args.selectorRequest,
      outputText: "",
      usage: null,
      latencyMs: 0,
    };
  },
};

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as { model: string };
      // Providers are always called streaming.
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", content: `served by ${body.model}` }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } },
      ].map((chunk) => `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 0, model: body.model, ...chunk })}\n\n`);
      return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  handler = createRequestHandler({
    platform: testPlatform({
      resolveRouter: async () => router,
      resolveProviderCredential: async () => ({
        apiKey: "upstream-key",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      }),
      readSessionPin: async (key) => pins.get(`${key.routerId}:${key.pinKey}`) ?? null,
      writeSessionPin: async ({ routerId, pinKey, ...pin }) => {
        pins.set(`${routerId}:${pinKey}`, pin);
      },
      recordRequest: (record) => {
        records.push(record);
      },
    }),
    selectorBackend: rotatingSelector,
  });
});

afterAll(async () => {
  await upstream.stop(true);
});

beforeEach(() => {
  pins.clear();
  records.length = 0;
  selections = 0;
  selectedEfforts = [];
  router = resolvedRouter({});
});

test("a session is routed once and keeps its model through compaction", async () => {
  const headers = { "x-session-affinity": MAIN_SESSION };
  const first = await chat({ headers, messages: [user("build the parser")] });
  const second = await chat({
    headers,
    messages: [user("build the parser"), assistant("done"), user("now the lexer")],
  });
  // A compacted transcript starts from a summary but is the same session.
  const compacted = await chat({ headers, messages: [user("Summary: parser and lexer built."), user("add tests")] });

  expect(await served(first)).toEqual({ model: MODEL_A, pinned: "true", lease: null });
  expect(await served(second)).toEqual({ model: MODEL_A, pinned: "true", lease: null });
  expect(await served(compacted)).toEqual({ model: MODEL_A, pinned: "true", lease: null });
  expect(selections).toBe(1);
  expect(pins.size).toBe(1);
});

test("each subagent gets its own routing decision, then keeps it", async () => {
  await (await chat({ headers: { "x-session-affinity": MAIN_SESSION }, messages: [user("plan")] })).text();
  const subagent = {
    "x-session-affinity": MAIN_SESSION,
    "x-opencode-session-id": "ses_child",
    "x-opencode-parent-session-id": "ses_parent",
  };
  const first = await chat({ headers: subagent, messages: [user("explore the repo")] });
  const second = await chat({
    headers: subagent,
    messages: [user("explore the repo"), assistant("looking"), user("continue")],
  });
  const main = await chat({
    headers: { "x-session-affinity": MAIN_SESSION },
    messages: [user("plan"), assistant("ok"), user("go")],
  });

  expect((await served(first)).model).toBe(MODEL_B);
  expect((await served(second)).model).toBe(MODEL_B);
  expect((await served(main)).model).toBe(MODEL_A);
  expect(selections).toBe(2);
  expect(pins.size).toBe(2);
});

test("Claude Code subagents are pinned by agent id and say so in dari_routing", async () => {
  const main = await claudeCode({ requestClass: "main" });
  const subagent = await claudeCode({ requestClass: "subagent", agentId: "agent_reviewer" });
  const mainAgain = await claudeCode({ requestClass: "main" });

  const mainBody = await main.json() as { dari_routing: Record<string, unknown> };
  const subagentBody = await subagent.json() as { dari_routing: Record<string, unknown> };
  const mainAgainBody = await mainAgain.json() as { dari_routing: Record<string, unknown> };
  expect(mainBody.dari_routing).toMatchObject({ selected_model: MODEL_A, session_pinned: true });
  expect(mainBody.dari_routing.lease_turns_remaining).toBeUndefined();
  expect(subagentBody.dari_routing).toMatchObject({ selected_model: MODEL_B, session_pinned: true });
  expect(mainAgainBody.dari_routing).toMatchObject({ selected_model: MODEL_A, session_pinned: true });
  expect(selections).toBe(2);

  // Records carry each request's own pin key, matching the stored pins.
  await waitForRecords(3);
  const keys = records.map((record) => record.sessionPinKey);
  expect(keys[0]).toBe(keys[2]);
  expect(keys[1]).not.toBe(keys[0]);
  expect(new Set(keys.map((key) => `${router.router_id}:${key}`))).toEqual(new Set(pins.keys()));
});

test("Claude Code without hint headers pins each conversation", async () => {
  const main = await claudeCode({ task: "main task" });
  const subagent = await claudeCode({ task: "subagent task" });
  const mainAgain = await claudeCode({ task: "main task" });

  expect((await main.json() as { dari_routing: Record<string, unknown> }).dari_routing.selected_model).toBe(MODEL_A);
  expect((await subagent.json() as { dari_routing: Record<string, unknown> }).dari_routing.selected_model).toBe(MODEL_B);
  expect((await mainAgain.json() as { dari_routing: Record<string, unknown> }).dari_routing.selected_model).toBe(MODEL_A);
  expect(selections).toBe(2);
});

test("Claude Code background requests never read or write pins", async () => {
  const response = await claudeCode({ requestClass: "auxiliary" });
  expect(response.status).toBe(200);
  const body = await response.json() as { dari_routing: Record<string, unknown> };
  expect(body.dari_routing.session_pinned).toBeUndefined();
  expect(pins.size).toBe(0);
  await waitForRecords(1);
  expect(records[0]!.sessionPinKey).toBeUndefined();
});

async function waitForRecords(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && records.length < count; attempt += 1) await Bun.sleep(5);
  expect(records).toHaveLength(count);
}

for (const harness of ["Claude Code", "Codex", "Muse Code"] as const) {
  test(`${harness} session effort applies to requested models, not routing`, async () => {
    const levels = ["low" as const, "high" as const];
    const base = router;
    router = {
      ...base,
      model_thinking_levels: { [MODEL_A]: levels, [MODEL_B]: levels, [MODEL_C]: levels },
      model_configs: Object.fromEntries(Object.entries(base.model_configs!).map(([model, config]) =>
        [model, { ...config, supported_thinking_levels: levels, default_thinking_level: "low" as const }])),
    };
    const send = (model: string) => harness === "Claude Code"
      ? claudeCode({ requestClass: "main", model, effort: "high" })
      : harness === "Codex"
        ? codex({ threadId: MAIN_SESSION, model, effort: "high" })
        : muse({ model, effort: "high" });

    expect((await send("dari/routing")).status).toBe(200);
    expect(new Set(selectedEfforts)).toEqual(new Set(levels));

    const requested = await send(`dari/model/${MODEL_B}`);
    expect(requested.headers.get("x-dari-thinking-level")).toBe("high");
  });
}

test("an explicit model serves its default when it lacks the requested level", async () => {
  const levels = ["low" as const, "high" as const];
  const base = router;
  router = {
    ...base,
    model_thinking_levels: { [MODEL_B]: levels },
    model_configs: { ...base.model_configs, [MODEL_B]: { ...base.model_configs![MODEL_B]!, supported_thinking_levels: levels, default_thinking_level: "low" as const } },
  };
  const response = await chat({
    model: `dari/model/${MODEL_B}`,
    headers: {},
    messages: [user("hi")],
    effort: "max",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-dari-thinking-level")).toBe("low");
});

test("Codex subagent threads are routed on their own", async () => {
  const main = await codex({ threadId: MAIN_SESSION });
  const subagent = await codex({ threadId: SUBAGENT_THREAD, parentThreadId: MAIN_SESSION, subagentKind: "review" });
  const subagentAgain = await codex({ threadId: SUBAGENT_THREAD, parentThreadId: MAIN_SESSION, subagentKind: "review" });

  expect((await served(main)).model).toBe(MODEL_A);
  expect(await served(subagent)).toEqual({ model: MODEL_B, pinned: "true", lease: null });
  expect((await served(subagentAgain)).model).toBe(MODEL_B);
  expect(selections).toBe(2);
});

test("a pin that can no longer serve is reselected and moved", async () => {
  const headers = { "x-session-affinity": MAIN_SESSION };
  expect((await served(await chat({ headers, messages: [user("hi")] }))).model).toBe(MODEL_A);
  router = resolvedRouter({ enabled_models: [MODEL_B, MODEL_C] });
  expect((await served(await chat({ headers, messages: [user("hi")] }))).model).toBe(MODEL_C);
  expect((await served(await chat({ headers, messages: [user("hi")] }))).model).toBe(MODEL_C);
  expect(selections).toBe(2);
  expect([...pins.values()]).toEqual([{ model: MODEL_C, reasoningEffort: "off" }]);
});

test("requested models bypass pinning", async () => {
  const response = await chat({
    model: `dari/model/${MODEL_B}`,
    headers: { "x-session-affinity": MAIN_SESSION },
    messages: [user("hi")],
  });
  expect(await served(response)).toEqual({ model: MODEL_B, pinned: null, lease: null });
  expect(selections).toBe(0);
  expect(pins.size).toBe(0);
});

test("routers without session pinning keep per-turn routing", async () => {
  router = resolvedRouter({ session_pinning: false });
  const headers = { "x-session-affinity": MAIN_SESSION };
  const first = await served(await chat({ headers, messages: [user("hi")] }));
  expect(first).toEqual({ model: MODEL_A, pinned: null, lease: "9" });
  expect(pins.size).toBe(0);
});

function resolvedRouter(overrides: Partial<ResolvedRouter>): ResolvedRouter {
  const config = (nativeId: string) => ({
    provider: "openrouter",
    native_model_id: nativeId,
    api: "openai-completions",
    supported_thinking_levels: ["off" as const],
    default_thinking_level: "off" as const,
    cost: { input: 1, output: 1, cached_input: 0.1, cache_write: 1 },
  });
  return {
    router_id: "rtr_pin",
    organization_id: "org_pin",
    api_key_id: null,
    attributed_user_id: null,
    enabled_models: [MODEL_A, MODEL_B, MODEL_C],
    provider_keys: { openrouter: "resolved-key" },
    primary_retries: 0,
    lease_context_enabled: false,
    session_pinning: true,
    routing_strategy: "dari",
    model_thinking_levels: { [MODEL_A]: ["off"], [MODEL_B]: ["off"], [MODEL_C]: ["off"] },
    model_prices: Object.fromEntries([MODEL_A, MODEL_B, MODEL_C].map((model) => [model, { input: 1, output: 1 }])),
    model_configs: {
      [MODEL_A]: config("acme/model-a"),
      [MODEL_B]: config("acme/model-b"),
      [MODEL_C]: config("acme/model-c"),
    },
    ...overrides,
  };
}

function user(content: string) {
  return { role: "user", content };
}

function assistant(content: string) {
  return { role: "assistant", content };
}

async function chat(args: {
  model?: string;
  headers: Record<string, string>;
  messages: Array<{ role: string; content: string }>;
  effort?: string;
}): Promise<Response> {
  return await handler(new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gw-key", "content-type": "application/json", ...args.headers },
    body: JSON.stringify({
      model: args.model ?? "dari/routing",
      messages: args.messages,
      ...(args.effort === undefined ? {} : { reasoning_effort: args.effort }),
    }),
  }));
}

async function claudeCode(args: {
  requestClass?: string;
  agentId?: string;
  task?: string;
  model?: string;
  effort?: string;
}): Promise<Response> {
  return await handler(new Request("http://gateway.test/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "gw-key",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.0 (external, cli)",
      "x-app": "cli",
      "x-claude-code-session-id": MAIN_SESSION,
      ...(args.requestClass === undefined ? {} : { "x-claude-code-request-class": args.requestClass }),
      ...(args.agentId === undefined ? {} : { "x-claude-code-agent-id": args.agentId }),
    },
    body: JSON.stringify({
      model: args.model ?? "dari/routing",
      max_tokens: 64,
      ...(args.effort === undefined
        ? {}
        : { thinking: { type: "adaptive" }, output_config: { effort: args.effort } }),
      messages: [{ role: "user", content: args.task ?? `task for ${args.agentId ?? "main"}` }],
    }),
  }));
}

async function responses(args: {
  headers: Record<string, string>;
  model: string;
  effort?: string;
}): Promise<Response> {
  return await handler(new Request("http://gateway.test/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gw-key", "content-type": "application/json", ...args.headers },
    body: JSON.stringify({
      model: args.model,
      input: [{ role: "user", content: [{ type: "input_text", text: "review the diff" }] }],
      ...(args.effort === undefined ? {} : { reasoning: { effort: args.effort } }),
    }),
  }));
}

async function codex(args: {
  threadId: string;
  parentThreadId?: string;
  subagentKind?: string;
  model?: string;
  effort?: string;
}): Promise<Response> {
  return await responses({
    headers: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: args.threadId,
        request_kind: "turn",
        ...(args.parentThreadId === undefined ? {} : { parent_thread_id: args.parentThreadId }),
        ...(args.subagentKind === undefined ? {} : { subagent_kind: args.subagentKind }),
      }),
    },
    model: args.model ?? "dari/routing",
    ...(args.effort === undefined ? {} : { effort: args.effort }),
  });
}

async function muse(args: { model: string; effort: string }): Promise<Response> {
  return await responses({ headers: { "x-client-id": "tbh:tui" }, model: args.model, effort: args.effort });
}

async function served(response: Response): Promise<{ model: string | null; pinned: string | null; lease: string | null }> {
  const text = await response.text();
  expect({ status: response.status, text: response.status === 200 ? "" : text }).toEqual({ status: 200, text: "" });
  return {
    model: response.headers.get("x-dari-selected-model"),
    pinned: response.headers.get("x-dari-session-pinned"),
    lease: response.headers.get("x-dari-lease-turns-remaining"),
  };
}
