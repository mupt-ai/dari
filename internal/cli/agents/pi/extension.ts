// The Dari provider for Pi. It mirrors each response's routing headers into
// Pi's footer: the model that served the turn, its thinking level, how many
// turns remain on the current lease, and a link to the conversation in
// Activity. A `dari pi` launch supplies the status renderer, the models to
// offer, the router's base URL, and its key through the environment; `pi` run
// directly reads the same from dari.json, which setup saves beside Pi's
// settings.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function savedSetup(): Record<string, any> {
  const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  try {
    return JSON.parse(readFileSync(join(dir, "dari.json"), "utf8"));
  } catch {
    return {};
  }
}

export default function (pi: any) {
  const saved = savedSetup();
  const executable = process.env.DARI_STATUS_EXECUTABLE ?? saved.statusExecutable
  // The models this organization can use, default first.
  const models: string[] = process.env.DARI_MODELS
    ? JSON.parse(process.env.DARI_MODELS)
    : saved.models ?? ["dari/routing"]
  const routingBaseURL = process.env.DARI_ROUTING_BASE_URL ?? saved.baseUrl ?? "https://routing.dari.dev"
  pi.registerProvider("dari", {
    name: "Dari",
    baseUrl: `${routingBaseURL}/v1`,
    apiKey: process.env.DARI_ROUTING_API_KEY ? "$DARI_ROUTING_API_KEY" : saved.apiKey,
    api: "openai-completions",
    compat: { sendSessionAffinityHeaders: true },
    models: models.map((id: string) => ({
      id,
      name: id === "dari/routing" ? "Dari Router" : id.replace("dari/model/", ""),
      reasoning: id !== "dari/routing",
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000000,
      maxTokens: 128000
    }))
  });

  // Tag requests from lifecycle events, never from summarization prompt text.
  // Pi gives summaries fresh cache IDs; keep their Activity session stable
  // without overriding x-session-affinity or the provider's cache key.
  let compacting = false;
  pi.on("session_before_compact", () => { compacting = true; });
  pi.on("session_compact", () => { compacting = false; });
  pi.on("session_compact_failed", () => { compacting = false; });
  pi.on("session_start", () => { compacting = false; });
  pi.on("before_provider_headers", (event: any, ctx: any) => {
    if (ctx.model?.provider !== "dari") return;
    event.headers["x-pi-session-id"] = ctx.sessionManager.getSessionId();
    event.headers["x-pi-request-kind"] = compacting ? "compaction" : "turn";
  });

  let headers: Record<string, string> | undefined;
  let revision = 0;
  const render = async (ctx: any, expectedRevision: number) => {
    if (!executable) return
    const result = await pi.exec(executable, [
      "agent-status", "--headers", JSON.stringify(headers)
    ], { timeout: 2000 });
    if (result.code === 0 && revision === expectedRevision) {
      const parts = result.stdout.trim().split(" · ");
      ctx.ui.setStatus("dari", parts.map((part: string, index: number) =>
        ctx.ui.theme.fg(index === 0 ? "accent" : "dim", part)
      ).join(" · "));
    }
  };

  pi.on("after_provider_response", async (event: any, ctx: any) => {
    if (!ctx.hasUI || !event.headers?.["x-dari-selected-model"]) return;
    headers = Object.fromEntries([
      "x-dari-selected-model", "x-dari-thinking-level", "x-dari-lease-turns-remaining", "x-dari-session-pinned", "x-request-id"
    ].filter(name => event.headers[name] !== undefined).map(name => [name, event.headers[name]]));
    await render(ctx, ++revision);
  });
}
