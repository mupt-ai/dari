// The Dari provider for Pi. It mirrors each response's routing headers into
// Pi's footer: the model that served the turn, its thinking level, how many
// turns remain on the current lease, and a link to the conversation in
// Activity. It also gives Pi a `web_search` tool when the router has a model
// that can search. A `dari pi` launch supplies the status renderer, the models
// to offer, the router's base URL, and its key through the environment; `pi`
// run directly reads the same from dari.json, which setup saves beside Pi's
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

type SearchResult = { summary: string; links: Array<{ title: string; url: string }> };
type SearchRequest = (path: string, headers: Record<string, string>, body: Record<string, unknown>) => Promise<any>;

const SEARCH_INSTRUCTIONS = "You run a web search for another model, which is waiting on the results. Search once, then reply with a brief summary of the results.";

// The search runs inside the model provider: OpenAI's hosted search on an
// OpenAI model, Anthropic's on a Claude model. Each asks for dari/routing, and
// the request is marked as a search, so Dari serves it on the cheapest model
// that can search, with or without the Autorouting plan. OpenAI is first
// because a ChatGPT plan can serve Pi and a Claude plan cannot.
const SEARCH_PROVIDERS: Array<{ models: string; search: (request: SearchRequest, key: string, prompt: string) => Promise<SearchResult> }> = [
  {
    models: "dari/model/openai/",
    async search(request, key, prompt) {
      const body = await request("/v1/responses", { authorization: `Bearer ${key}` }, {
        model: "dari/routing", instructions: SEARCH_INSTRUCTIONS, input: prompt, tools: [{ type: "web_search" }],
      });
      const result: SearchResult = { summary: "", links: [] };
      for (const item of body.output ?? []) {
        for (const part of item.type === "message" ? item.content ?? [] : []) {
          if (part.type !== "output_text") continue;
          result.summary += part.text;
          for (const note of part.annotations ?? []) {
            if (note.type === "url_citation") result.links.push({ title: note.title, url: note.url });
          }
        }
      }
      return result;
    },
  },
  {
    models: "dari/model/anthropic/claude-",
    async search(request, key, prompt) {
      const body = await request("/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, {
        model: "dari/routing", max_tokens: 4096, system: SEARCH_INSTRUCTIONS, messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      });
      const result: SearchResult = { summary: "", links: [] };
      for (const block of body.content ?? []) {
        if (block.type === "text") result.summary += block.text;
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const page of block.content) result.links.push({ title: page.title, url: page.url });
        }
      }
      return result;
    },
  },
];

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

  // When one provider cannot serve the search (a plan out of usage, a key
  // rejected), the next one does, within the same tool call.
  const searchProviders = SEARCH_PROVIDERS.filter((provider) => models.some((id) => id.startsWith(provider.models)));
  if (searchProviders.length > 0) {
    const webSearch = {
      name: "web_search",
      label: "Web Search",
      description: "Search the web for current information. Returns a brief summary of the results and their links.",
      promptSnippet: "Search the web for current information",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The search query" } },
        required: ["query"],
      },
      async execute(_id: string, params: { query: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
        const key = process.env.DARI_ROUTING_API_KEY ?? saved.apiKey;
        const request: SearchRequest = async (path, headers, body) => {
          const response = await fetch(routingBaseURL + path, {
            method: "POST",
            signal,
            headers: {
              "content-type": "application/json",
              "x-pi-session-id": ctx.sessionManager.getSessionId(),
              "x-pi-request-kind": "search",
              ...headers,
            },
            body: JSON.stringify(body),
          });
          const answer = await response.json().catch(() => undefined);
          if (!response.ok) throw new Error(answer?.error?.message ?? `The request failed with status ${response.status}.`);
          return answer ?? {};
        };
        const failures: string[] = [];
        for (const provider of searchProviders) {
          try {
            const { summary, links } = await provider.search(request, key, `Perform a web search for the query: ${params.query}`);
            const unique = links.filter((link, index) => links.findIndex((other) => other.url === link.url) === index);
            const text = [
              `Web search results for "${params.query}":`,
              summary.trim(),
              ...(unique.length > 0 ? [`Links:\n${unique.map((link) => `- ${link.title}: ${link.url}`).join("\n")}`] : []),
            ].join("\n\n");
            return { content: [{ type: "text", text }], details: { links: unique } };
          } catch (error) {
            if (signal?.aborted) throw error;
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
        throw new Error(`Web search failed. ${failures.join(" ")}`);
      },
    };
    // A `web_search` the user already has is theirs to keep: Pi refuses to
    // start when two extensions register a tool of one name as they load, and
    // drops the later of two registered afterwards. So this one waits for the
    // first prompt, by when other extensions have registered theirs, whether
    // on load or at session start.
    let offered = false;
    pi.on("before_agent_start", () => {
      if (offered || pi.getAllTools().some((tool: any) => tool.name === webSearch.name)) return;
      offered = true;
      pi.registerTool(webSearch);
    });
  }

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
