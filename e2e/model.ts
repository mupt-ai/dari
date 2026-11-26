/**
 * The stand-in model provider every end-to-end test talks to: Anthropic's
 * Messages API, OpenAI's Responses API, and the ChatGPT Codex backend, on one
 * port. No test reaches a real provider.
 *
 * It is one scripted model. What it answers depends only on the conversation
 * it is sent, never on which API carried it, so the same prompt drives every
 * coding agent through every provider:
 *
 * - `e2e:tool` in the user's prompt: call the agent's shell tool once
 *   (`echo E2E_TOOL_RAN`), then answer `E2E_DONE` with what the tool printed.
 * - `e2e:subagent`: start one subagent with the agent's own tool for that,
 *   then answer `E2E_DONE`. The subagent's prompt is `e2e:child`, which is
 *   answered `E2E_CHILD`.
 * - anything else: `E2E_DONE`.
 *
 * A request that offers a single tool wants its answer as that tool's
 * arguments, so it gets them.
 *
 * `calls` records each provider call as it arrived.
 */
import { zstdDecompressSync } from "node:zlib";

export const TOOL_OUTPUT = "E2E_TOOL_RAN";
export const DONE = "E2E_DONE";
export const CHILD_DONE = "E2E_CHILD";

export type ModelCall = {
  api: "anthropic_messages" | "openai_responses";
  path: string;
  // The plan's access token or the API key the call was signed with.
  token: string;
  model: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  // Where the call falls in the script: the model calling the shell tool or
  // spawning a subagent, the subagent's own answer, the agent's answer once
  // its tool ran, or anything else (a title, a plain prompt).
  // "refused" is a call turned away at the plan's usage limit.
  step: "shell" | "spawn" | "child" | "answer" | "other" | "refused";
  reply: Reply;
};

type Tool = { name: string; schema: Record<string, unknown> };
type Reply =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: Record<string, unknown> };

// The conversation as the script reads it, whichever API carried it.
type Turn = { userText: string[]; toolResults: string[]; tools: Tool[] };

export type Model = { url: string; calls: ModelCall[]; stop(): Promise<void> };

/** `atLimit` are the plan tokens whose every call is refused as over the plan's usage limit. */
export function startModel(atLimit: readonly string[] = []): Model {
  const calls: ModelCall[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // A coding agent's request can be a megabyte of tool definitions.
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "GET") {
        // The Codex backend's usage report: a fresh plan.
        if (pathname.endsWith("/wham/usage")) {
          return Response.json({ rate_limit: { primary_window: { used_percent: 0, reset_at: null } } });
        }
        // A key check (list models) and anything else an agent reads.
        return Response.json({ data: [] });
      }
      if (request.method !== "POST") return new Response(null, { status: 404 });
      const api = pathname.endsWith("/messages") ? "anthropic_messages"
        : pathname.endsWith("/responses") ? "openai_responses"
        : null;
      if (api === null) return new Response(null, { status: 404 });
      const body = await readJson(request);
      const headers = Object.fromEntries(request.headers);
      const token = (headers.authorization ?? "").replace(/^Bearer /, "") || headers["x-api-key"] || "";
      if (atLimit.includes(token)) {
        calls.push({ api, path: pathname, token, model: String(body.model ?? ""), headers, body, step: "refused", reply: { type: "text", text: "" } });
        return limitRefusal(api);
      }
      const turn = api === "anthropic_messages" ? anthropicTurn(body) : responsesTurn(body);
      const { step, reply } = script(turn);
      calls.push({
        api,
        path: pathname,
        token,
        model: String(body.model ?? ""),
        headers,
        body,
        step,
        reply,
      });
      const model = String(body.model ?? "");
      if (api === "anthropic_messages") {
        return body.stream === true ? anthropicStream(model, reply) : Response.json(anthropicMessage(model, reply));
      }
      return responsesStream(model, reply);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: async () => {
      await server.stop(true);
    },
  };
}

function script(turn: Turn): { step: ModelCall["step"]; reply: Reply } {
  const prompt = turn.userText.join("\n");
  const ran = turn.toolResults.length > 0;
  // A request with one tool wants its answer as that tool's arguments (Muse
  // Code's reminder check); it is not the agent's turn.
  if (turn.tools.length === 1 && !ran) {
    return { step: "other", reply: { type: "tool", name: turn.tools[0]!.name, input: filled(turn.tools[0]!, () => undefined) } };
  }
  // Nor is one with no tools, which carries the user's prompt all the same
  // (OpenCode's session title).
  if (turn.tools.length === 0) return { step: "other", reply: { type: "text", text: DONE } };
  if (prompt.includes("e2e:child")) return { step: "child", reply: { type: "text", text: CHILD_DONE } };
  if (prompt.includes("e2e:tool")) {
    if (!ran) return { step: "shell", reply: shellCall(turn.tools) };
    const printed = turn.toolResults.some((result) => result.includes(TOOL_OUTPUT));
    return { step: "answer", reply: { type: "text", text: `${DONE} ${printed ? TOOL_OUTPUT : "without the tool's output"}` } };
  }
  if (prompt.includes("e2e:subagent")) {
    if (!ran) return { step: "spawn", reply: subagentCall(turn.tools) };
    // Codex's spawn returns at once with the subagent's id, and `codex exec`
    // exits on the answer; wait for the subagent first.
    const spawned = turn.toolResults.length === 1 ? /agent_id[\\":]+([0-9a-f-]{36})/.exec(turn.toolResults[0]!)?.[1] : undefined;
    if (spawned !== undefined && turn.tools.some((tool) => tool.name === CODEX_WAIT_TOOL)) {
      return { step: "other", reply: { type: "tool", name: CODEX_WAIT_TOOL, input: { targets: [spawned] } } };
    }
    return { step: "answer", reply: { type: "text", text: DONE } };
  }
  return { step: "other", reply: { type: "text", text: DONE } };
}

// Each agent names its shell tool, its subagent tool, and their arguments its
// own way: Claude Code, Codex, OpenCode, Pi, and Muse Code, in that order.
const SHELL_TOOLS = ["Bash", "exec_command", "shell", "bash", "muse__bash"];
const SUBAGENT_TOOLS = ["Agent", "multi_agent_v1__spawn_agent", "subagent"];
const CODEX_WAIT_TOOL = "multi_agent_v1__wait_agent";

function shellCall(tools: Tool[]): Reply {
  const tool = tools.find((candidate) => SHELL_TOOLS.includes(candidate.name));
  if (tool === undefined) return { type: "text", text: `no shell tool among: ${tools.map((candidate) => candidate.name).join(", ")}` };
  return { type: "tool", name: tool.name, input: filled(tool, (name) =>
    name === "command" || name === "cmd" ? `echo ${TOOL_OUTPUT}` : undefined) };
}

function subagentCall(tools: Tool[]): Reply {
  const tool = tools.find((candidate) => SUBAGENT_TOOLS.includes(candidate.name));
  if (tool === undefined) return { type: "text", text: `no subagent tool among: ${tools.map((candidate) => candidate.name).join(", ")}` };
  return { type: "tool", name: tool.name, input: filled(tool, (name) => {
    if (name === "prompt" || name === "message") return "e2e:child";
    // Claude Code's general agent is `general-purpose`; OpenCode's is `general`.
    if (name === "subagent_type") return "general-purpose";
    if (name === "agent") return "general";
    return undefined;
  }) };
}

// The tool's required arguments: `value` names the ones the script cares
// about, and the rest get a plain value of their type.
function filled(tool: Tool, value: (name: string) => unknown): Record<string, unknown> {
  const properties = (tool.schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(tool.schema.required) ? tool.schema.required as string[] : []);
  const input: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    const chosen = value(name);
    if (chosen !== undefined) input[name] = chosen;
    else if (required.has(name)) {
      input[name] = property.type === "boolean" ? false
        : property.type === "number" || property.type === "integer" ? 1
        : property.type === "array" ? []
        : property.type === "object" ? {}
        : "e2e";
    }
  }
  return input;
}

// A plan at its usage limit for the next hour, as Claude and ChatGPT say it.
function limitRefusal(api: ModelCall["api"]): Response {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  if (api === "openai_responses") {
    return Response.json(
      { error: { type: "usage_limit_reached", code: "usage_limit_reached", message: "The usage limit has been reached", resets_at: reset } },
      { status: 429 },
    );
  }
  return Response.json(
    { type: "error", error: { type: "rate_limit_error", message: "usage limit" } },
    {
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(reset),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      },
    },
  );
}

function anthropicTurn(body: Record<string, unknown>): Turn {
  const turn: Turn = { userText: [], toolResults: [], tools: [] };
  for (const tool of asArray(body.tools)) {
    // The gateway's client pads an Anthropic tool list with a placeholder.
    if (typeof tool.name === "string" && !tool.name.startsWith("__pi_")) turn.tools.push({ name: tool.name, schema: asRecord(tool.input_schema) });
  }
  for (const message of asArray(body.messages)) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") turn.userText.push(message.content);
    for (const block of asArray(message.content)) {
      if (block.type === "text" && typeof block.text === "string") turn.userText.push(block.text);
      if (block.type === "tool_result") turn.toolResults.push(JSON.stringify(block.content ?? ""));
    }
  }
  return turn;
}

function responsesTurn(body: Record<string, unknown>): Turn {
  const turn: Turn = { userText: [], toolResults: [], tools: [] };
  for (const tool of asArray(body.tools)) {
    if (tool.type === "function" && typeof tool.name === "string") {
      turn.tools.push({ name: tool.name, schema: asRecord(tool.parameters) });
    }
  }
  if (typeof body.input === "string") turn.userText.push(body.input);
  for (const item of asArray(body.input)) {
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      turn.toolResults.push(JSON.stringify(item.output ?? ""));
    }
    if (item.role !== "user") continue;
    if (typeof item.content === "string") turn.userText.push(item.content);
    for (const part of asArray(item.content)) {
      if (typeof part.text === "string") turn.userText.push(part.text);
    }
  }
  return turn;
}

function anthropicMessage(model: string, reply: Reply) {
  return {
    id: `msg_${id()}`,
    type: "message",
    role: "assistant",
    model,
    content: [reply.type === "text"
      ? { type: "text", text: reply.text }
      : { type: "tool_use", id: `toolu_${id()}`, name: reply.name, input: reply.input }],
    stop_reason: reply.type === "text" ? "end_turn" : "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
  };
}

function anthropicStream(model: string, reply: Reply): Response {
  const message = anthropicMessage(model, reply);
  const block = message.content[0]!;
  const start = block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} };
  const delta = block.type === "text"
    ? { type: "text_delta", text: block.text }
    : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
  return sse([
    { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: start },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
}

function responsesStream(model: string, reply: Reply): Response {
  const response = { id: `resp_${id()}`, object: "response", model, status: "in_progress", output: [] as unknown[] };
  const item = reply.type === "text"
    ? { id: `msg_${id()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply.text, annotations: [] }] }
    : { id: `fc_${id()}`, type: "function_call", status: "completed", call_id: `call_${id()}`, name: reply.name, arguments: JSON.stringify(reply.input) };
  const events: Array<Record<string, unknown>> = [{ type: "response.created", response }];
  if (item.type === "message") {
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: item.content![0]!.text },
      { type: "response.output_text.done", output_index: 0, item_id: item.id, content_index: 0, text: item.content![0]!.text },
      { type: "response.content_part.done", output_index: 0, item_id: item.id, content_index: 0, part: item.content![0] },
    );
  } else {
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments },
    );
  }
  events.push(
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 },
      },
    },
  );
  return sse(events.map((event, index) => ({ ...event, sequence_number: index })));
}

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

// The Codex transport sends zstd-compressed bodies.
async function readJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const text = request.headers.get("content-encoding") === "zstd"
    ? zstdDecompressSync(bytes).toString("utf8")
    : new TextDecoder().decode(bytes);
  return asRecord(JSON.parse(text));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function id(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 24);
}
