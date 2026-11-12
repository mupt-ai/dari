/**
 * The model lists saved through the gateway's API, which `dari gateway models`
 * calls: a router's own list and each coding agent's. They live in SQLite and
 * are served in place of the config file's, so the file is never rewritten
 * and a change needs no restart.
 */
import type { Database } from "bun:sqlite";

import { errorResponse, HttpError } from "../http/errors.js";
import { CLIENT_HARNESSES } from "../ingress/client_harness.js";
import { DEFAULT_ROUTER_ALIAS } from "../platform/routing_contract.js";
import type { ClientHarness } from "../types.js";
import {
  DEFAULT_GATEWAY_CONFIG,
  parseRouterModels,
  type GatewayConfig,
  type RouterConfig,
  type RouterModelConfig,
} from "./config.js";

// A router's own list is saved under no agent.
const ROUTER_LIST = "";

export class RouterModelStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS router_models (
      router_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      models TEXT NOT NULL,
      PRIMARY KEY (router_id, agent)
    )`);
  }

  /** The router as served: each saved list in place of its config's. */
  served(routerId: string, router: RouterConfig): RouterConfig {
    const rows = this.db
      .query<{ agent: string; models: string }, [string]>(
        "SELECT agent, models FROM router_models WHERE router_id = ?",
      )
      .all(routerId);
    if (rows.length === 0) return router;
    const served = { ...router, agentModels: { ...router.agentModels } };
    for (const row of rows) {
      const models = JSON.parse(row.models) as RouterModelConfig[];
      if (row.agent === ROUTER_LIST) served.models = models;
      else served.agentModels[row.agent as ClientHarness] = models;
    }
    return served;
  }

  /** The routers with a saved list. */
  routersWithSavedLists(): string[] {
    return this.db
      .query<{ router_id: string }, []>("SELECT DISTINCT router_id FROM router_models ORDER BY router_id")
      .all()
      .map((row) => row.router_id);
  }

  /** Whether the router's own list is a saved one. */
  hasRouterList(routerId: string): boolean {
    return this.db
      .query("SELECT 1 FROM router_models WHERE router_id = ? AND agent = ?")
      .get(routerId, ROUTER_LIST) !== null;
  }

  /** Save the router's own list, or one coding agent's. */
  save(routerId: string, agent: ClientHarness | undefined, models: RouterModelConfig[]): void {
    this.db
      .query(
        `INSERT INTO router_models (router_id, agent, models) VALUES (?, ?, ?)
         ON CONFLICT (router_id, agent) DO UPDATE SET models = excluded.models`,
      )
      .run(routerId, agent ?? ROUTER_LIST, JSON.stringify(models));
  }

  /** Forget a saved list, so the config's is served again. */
  remove(routerId: string, agent: ClientHarness | undefined): void {
    this.db
      .query("DELETE FROM router_models WHERE router_id = ? AND agent = ?")
      .run(routerId, agent ?? ROUTER_LIST);
  }
}

/** `/v1/router/models` for the default router, `/<router>/v1/router/models` for another; a coding agent's list is one segment below. */
export const ROUTER_MODELS_ROUTE = /^(?:\/([^/]+))?\/v1\/router\/models(?:\/([^/]+))?$/;

/**
 * Serve a router's model lists. The caller authenticates the gateway key.
 *
 * - `GET /v1/router/models` returns the lists as served.
 * - `PUT /v1/router/models` with `{ "models": [...] }` saves the router's own
 *   list, and `DELETE` goes back to the config file's.
 * - `PUT` and `DELETE /v1/router/models/<agent>` do the same for one coding
 *   agent's list.
 *
 * Each answers with the lists as served after the change. Returns null for
 * any other path.
 */
export async function handleRouterModelsRequest(
  request: Request,
  deps: { config: GatewayConfig; routerModels: RouterModelStore },
): Promise<Response | null> {
  const route = ROUTER_MODELS_ROUTE.exec(new URL(request.url).pathname);
  if (route === null) return null;
  try {
    const routerId = route[1] ?? DEFAULT_ROUTER_ALIAS;
    const configured = deps.config.routers[routerId];
    if (configured === undefined) {
      throw new HttpError(404, `Router ${routerId} is not configured on this gateway.`, "router_not_found");
    }
    const agent = route[2] as ClientHarness | undefined;
    if (agent !== undefined && !CLIENT_HARNESSES.includes(agent)) {
      throw new HttpError(
        404,
        `Unknown coding agent '${agent}'; use ${CLIENT_HARNESSES.join(", ")}.`,
        "coding_agent_not_found",
      );
    }
    if (request.method === "PUT") {
      deps.routerModels.save(routerId, agent, await requestedModels(request, routerId));
    } else if (request.method === "DELETE") {
      deps.routerModels.remove(routerId, agent);
    } else if (request.method !== "GET" || agent !== undefined) {
      throw new HttpError(405, "Method not allowed.", "method_not_allowed");
    }
    const served = deps.routerModels.served(routerId, configured);
    return Response.json(
      {
        models: served.models,
        agent_models: served.agentModels,
        // False while the router serves the gateway's built-in default
        // models, which nobody chose.
        chosen: deps.config !== DEFAULT_GATEWAY_CONFIG || deps.routerModels.hasRouterList(routerId),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function requestedModels(request: Request, routerId: string): Promise<RouterModelConfig[]> {
  const body: unknown = await request.json().catch(() => null);
  try {
    return parseRouterModels(routerId, "models", (body as { models?: unknown } | null)?.models);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error), "invalid_request_error", "models");
  }
}
