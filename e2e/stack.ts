/**
 * Everything a real coding agent talks to when it is launched with `dari
 * <agent>`, run on this machine with no network:
 *
 *   dari <agent>              the Dari CLI built from this checkout, which
 *     │                       sets the agent up as a launch does
 *     ▼
 *   the agent's own binary    Claude Code, Codex, OpenCode, Pi, Muse Code
 *     │
 *     ▼
 *   this computer's gateway   packages/gateway, connected to hosted Dari as
 *     │                       the CLI starts it, with one Claude Code plan
 *     │                       and one ChatGPT plan
 *     ├── the plans ────────► the stand-in provider (model.ts)
 *     ▼
 *   hosted Dari               a stand-in: the routes only hosted Dari has
 *     │                       (the router, the selector, the Activity upload)
 *     │                       are answered here, and a model it serves runs
 *     │                       on a second gateway, which shares hosted Dari's
 *     │                       request handling and keeps its own Activity
 *     ▼
 *   the stand-in provider
 *
 * The router has a model for each way a request can be served: `ON_PLAN_*`
 * on this computer's plans, and `ON_DARI_*` only by hosted Dari. `launch`
 * runs one agent session routed to one of them and returns what every part
 * saw of it.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secretBoxFromEnv } from "../packages/gateway/src/self_host/secret_box.ts";
import { SubscriptionStore } from "../packages/gateway/src/self_host/subscriptions/index.ts";
import { startModel, type ModelCall } from "./model.ts";

// Served by the Claude Code plan on this computer (to Claude Code only), and
// by hosted Dari when the plan cannot.
export const ON_PLAN_CLAUDE = "anthropic/claude-sonnet-5-5";
// Served by the ChatGPT plan on this computer, and by hosted Dari when the
// plan cannot.
export const ON_PLAN_GPT = "openai/gpt-6.2-astra";
// Served only by hosted Dari, which this computer reaches over Anthropic's API.
export const ON_DARI_CLAUDE = "anthropic/claude-opus-5-5";
// Served only by hosted Dari, which this computer reaches over OpenAI's Responses API.
export const ON_DARI_GPT = "openai/gpt-6.1-sol";

// What each model's provider call is signed with.
export const CLAUDE_PLAN_TOKEN = "sk-ant-oat01-e2e";
// A ChatGPT access token is a JWT naming its account; the stand-in is unsigned.
export const CHATGPT_PLAN_TOKEN = ["e30", Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_e2e" },
})).toString("base64url"), "e2e"].join(".");
export const DARI_ANTHROPIC_KEY = "dari-anthropic-key";
export const DARI_OPENAI_KEY = "dari-openai-key";

// The router's prompt for each agent role.
export const ROLE_PROMPTS = { main: "E2E_MAIN_ROLE_PROMPT", subagent: "E2E_SUBAGENT_ROLE_PROMPT" };

const GATEWAY_KEY = "e2e-gateway-key";
const DARI_KEY = "dari_e2e_user_key";
const ROOT = join(import.meta.dir, "..");
const GATEWAY_MAIN = join(ROOT, "packages/gateway/src/self_host/main.ts");

export type Agent = "claude" | "codex" | "opencode" | "pi" | "muse";

/** One request as Activity shows it. */
export type ActivityStep = {
  model: string;
  // "unknown" when the agent did not say what the request was for.
  requestClass: string;
  agentId: string | null;
  agentType: string | null;
  // The agent's session the request belongs to, or null without one.
  session: string | null;
  // Who served it: this computer's gateway (which uploads it to hosted
  // Activity) or hosted Dari.
  servedBy: "computer" | "dari";
};

export type Session = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Every provider call, in order. */
  calls: ModelCall[];
  /** Every request in Activity, in order within each server. */
  activity: ActivityStep[];
  /** The headers of each request hosted Dari was asked to serve. */
  dariRequests: Array<Record<string, string>>;
};

// The CLI under test: this checkout's, built once per run.
let dariBinary: Promise<string> | undefined;
function buildDari(): Promise<string> {
  dariBinary ??= (async () => {
    const out = join(mkdtempSync(join(tmpdir(), "dari-e2e-bin-")), "dari");
    const build = Bun.spawn(["go", "build", "-o", out, "./cmd/dari"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (await build.exited !== 0) throw new Error("go build ./cmd/dari failed");
    return out;
  })();
  return dariBinary;
}

/**
 * Run `dari <agent> <args>` as a new user on a new machine, with `dari/routing`
 * picking `model`, and wait for the agent to exit.
 */
export async function launch(agent: Agent, args: string[], options: {
  model: string;
  // The plans on this computer are at their usage limit.
  plansAtLimit?: boolean;
}): Promise<Session> {
  const dari = await buildDari();
  const dir = mkdtempSync(join(tmpdir(), "dari-e2e-"));
  const model = startModel(options.plansAtLimit ? [CLAUDE_PLAN_TOKEN, CHATGPT_PLAN_TOKEN] : []);

  // Hosted Dari's own serving: a gateway on API keys, with Activity.
  const dariConfig = join(dir, "dari.json");
  writeFileSync(dariConfig, JSON.stringify({
    routers: {
      default: {
        models: [ON_PLAN_CLAUDE, ON_PLAN_GPT, ON_DARI_CLAUDE, ON_DARI_GPT].map((id) => ({ id, sources: ["key"] })),
        rolePrompts: ROLE_PROMPTS,
      },
    },
    providers: {
      anthropic: { baseUrl: `${model.url}/anthropic`, api: "anthropic-messages", apiKeyEnv: "ANTHROPIC_API_KEY" },
      openai: { baseUrl: `${model.url}/openai/v1`, api: "openai-responses", apiKeyEnv: "OPENAI_API_KEY" },
    },
  }));
  const dariGateway = await startGateway({
    DARI_GATEWAY_KEYS: DARI_KEY,
    DARI_GATEWAY_CONFIG: dariConfig,
    DARI_GATEWAY_DB: join(dir, "dari.db"),
    ANTHROPIC_API_KEY: DARI_ANTHROPIC_KEY,
    OPENAI_API_KEY: DARI_OPENAI_KEY,
  });

  // The routes only hosted Dari has; everything else is its serving.
  const uploads: Array<Record<string, unknown>> = [];
  const dariRequests: Session["dariRequests"] = [];
  const router = {
    models: [
      // A plan first; hosted Dari when no plan can serve.
      { id: ON_PLAN_CLAUDE, thinking: null, sources: ["plan", "managed"] },
      { id: ON_PLAN_GPT, thinking: null, sources: ["plan", "managed"] },
      { id: ON_DARI_CLAUDE, thinking: null, sources: ["managed"] },
      { id: ON_DARI_GPT, thinking: null, sources: ["managed"] },
    ],
    reset_min_hours: 24,
    native_compaction: false,
    zdr: false,
    session_pinning: false,
    retries: 0,
    role_models: {},
    role_prompts: ROLE_PROMPTS,
    custom_rules: false,
  };
  const hosted = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/gateway/router") return Response.json(router);
      if (url.pathname === "/v1/gateway/subscriptions") return Response.json({ subscriptions: [] });
      if (url.pathname === "/v1/gateway/requests") {
        const body = await request.json() as { requests: Array<{ row: Record<string, unknown> }> };
        uploads.push(...body.requests.map((entry) => entry.row));
        return Response.json({ stored: body.requests.map((entry) => entry.row.request_id), rejected: [] });
      }
      if (url.pathname === "/v1/auto-router/select") {
        // The selector picks among the pairs it is offered: the model the
        // test wants, at the first thinking level this request may use.
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        const input = JSON.parse(body.messages.find((message) => message.role === "user")!.content) as {
          candidate_pairs: Array<{ model: string; thinking_level: string }>;
        };
        const pair = input.candidate_pairs.find((candidate) => candidate.model === options.model);
        if (pair === undefined) {
          const offered = [...new Set(input.candidate_pairs.map((candidate) => candidate.model))];
          console.error(`e2e: ${options.model} is not a candidate for this request; offered ${offered.join(", ")}`);
          return new Response("not a candidate", { status: 500 });
        }
        return Response.json({ selected_model: pair.model, reasoning_effort: pair.thinking_level, reason: "e2e", lease_turns_remaining: 1 });
      }
      if (request.method === "POST" && /\/(messages|responses|chat\/completions)$/.test(url.pathname)) {
        dariRequests.push(Object.fromEntries(request.headers));
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      const response = await fetch(`${dariGateway.url}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer(),
      });
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    },
  });

  // This computer's gateway, connected to hosted Dari, with its plans.
  const gatewayDb = join(dir, "gateway.db");
  const encryptionKey = randomBytes(32).toString("base64");
  const plans = new SubscriptionStore(new Database(gatewayDb), secretBoxFromEnv(encryptionKey));
  const expiresAt = new Date(Date.now() + 86_400_000);
  plans.connect({
    provider: "anthropic_claude_code",
    accessToken: CLAUDE_PLAN_TOKEN,
    refreshToken: "refresh",
    expiresAt,
    accountId: null,
    accountEmail: "e2e@example.com",
  }, null);
  plans.connect({
    provider: "openai_codex",
    accessToken: CHATGPT_PLAN_TOKEN,
    refreshToken: "refresh",
    expiresAt,
    accountId: "acct_e2e",
    accountEmail: "e2e@example.com",
  }, null);
  const gatewayConfig = join(dir, "gateway.json");
  writeFileSync(gatewayConfig, JSON.stringify({
    routers: { default: { models: [ON_PLAN_CLAUDE] } },
    providers: {
      anthropic: { baseUrl: `${model.url}/anthropic`, api: "anthropic-messages" },
      "openai-codex": { baseUrl: `${model.url}/backend-api` },
    },
  }));
  const gateway = await startGateway({
    DARI_GATEWAY_KEYS: GATEWAY_KEY,
    DARI_GATEWAY_CONFIG: gatewayConfig,
    DARI_GATEWAY_DB: gatewayDb,
    DARI_GATEWAY_ENCRYPTION_KEY: encryptionKey,
    DARI_HOSTED_URL: `http://127.0.0.1:${hosted.port}`,
    DARI_HOSTED_API_KEY: DARI_KEY,
    DARI_GATEWAY_ID: "gw_e2e",
    DARI_GATEWAY_NAME: "e2e",
  });

  try {
    const home = join(dir, "home");
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const child = Bun.spawn([dari, agent, ...args], {
      cwd: work,
      // Nothing of the developer's own setup: no keys, no agent config.
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        LANG: "en_US.UTF-8",
        TERM: "dumb",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_STATE_HOME: join(home, ".local/state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        // The gateway the launch runs through. A launch signed in to Dari
        // starts its own on a fixed port; naming this one here is the only
        // difference from that launch.
        DARI_GATEWAY_URL: gateway.url,
        DARI_GATEWAY_KEY: GATEWAY_KEY,
        // No agent updates itself mid-run.
        DISABLE_AUTOUPDATER: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        MUSE_NO_AUTO_UPDATE: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);

    // The gateway uploads what it served in the background, a moment after
    // it answers.
    const onPlan = model.calls.filter((call) => call.step !== "refused"
      && (call.token === CLAUDE_PLAN_TOKEN || call.token === CHATGPT_PLAN_TOKEN)).length;
    for (let attempt = 0; attempt < 100 && uploads.length < onPlan; attempt += 1) await Bun.sleep(100);
    const activity = [
      ...uploads.map(uploadedStep),
      ...await dariActivity(dariGateway.url),
    ];
    return { exitCode, stdout, stderr, calls: model.calls, activity, dariRequests };
  } finally {
    await gateway.stop();
    await dariGateway.stop();
    await hosted.stop(true);
    await model.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A request this computer's gateway served, as it uploads it to hosted Activity.
function uploadedStep(row: Record<string, unknown>): ActivityStep {
  const metadata = (row.request_metadata ?? {}) as { agent_context?: { requestClass?: string; agentId?: string; agentType?: string } };
  return {
    model: String(row.selected_model),
    requestClass: metadata.agent_context?.requestClass ?? "unknown",
    agentId: metadata.agent_context?.agentId ?? null,
    agentType: metadata.agent_context?.agentType ?? null,
    session: typeof row.agent_session_id === "string" ? row.agent_session_id : null,
    servedBy: "computer",
  };
}

// The requests hosted Dari served, read from its Activity API.
async function dariActivity(url: string): Promise<ActivityStep[]> {
  const range = `from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`
    + `&to=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`;
  const read = async (path: string) => {
    const response = await fetch(`${url}/v1/organizations/current/routing/activity/${path}&${range}`, {
      headers: { authorization: `Bearer ${DARI_KEY}` },
    });
    if (!response.ok) throw new Error(`Activity ${path}: HTTP ${response.status} ${await response.text()}`);
    return await response.json() as Record<string, unknown>;
  };
  const list = await read("conversations?limit=100") as {
    conversations: Array<{ conversation_ref: string }>;
  };
  const steps = new Map<string, ActivityStep & { at: string }>();
  for (const listed of list.conversations) {
    const detail = await read(`conversations/${listed.conversation_ref}?limit=100`) as {
      conversation: { agent_session_id: string | null };
      steps: Array<{ id: string; received_at: string; selected_model: string; request_class: string; agent_id: string | null; agent_type: string | null }>;
    };
    for (const step of detail.steps) {
      steps.set(step.id, {
        model: step.selected_model,
        requestClass: step.request_class,
        agentId: step.agent_id,
        agentType: step.agent_type,
        session: detail.conversation.agent_session_id,
        servedBy: "dari",
        at: step.received_at,
      });
    }
  }
  return [...steps.values()].sort((a, b) => a.at.localeCompare(b.at)).map(({ at: _, ...step }) => step);
}

async function startGateway(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const child = Bun.spawn(["bun", GATEWAY_MAIN], {
    env: { PATH: process.env.PATH ?? "", PORT: String(port), ...env },
    stdout: "pipe",
    // E2E_DEBUG=1 shows both gateways' logs.
    stderr: process.env.E2E_DEBUG ? "inherit" : "ignore",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("dari-gateway listening")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`The gateway exited before listening:\n${output}`);
    output += decoder.decode(value);
  }
  reader.releaseLock();
  void child.stdout.pipeTo(new WritableStream({
    write(chunk) {
      if (process.env.E2E_DEBUG) process.stderr.write(chunk);
    },
  }));
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill();
      await child.exited;
    },
  };
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}
