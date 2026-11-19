/**
 * Router specs (see parseRouterSpec): whole routers saved through the
 * gateway's API, which the Dari CLI pushes, and those read at startup from
 * `DARI_GATEWAY_ROUTERS_DIR`. A spec is served in place of the config file's
 * router of its id: a saved one first, then a file's. Saved specs live in
 * SQLite, so a change needs no restart.
 */
import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { errorResponse, HttpError } from "../http/errors.js";
import {
  parseRouterSpec,
  parseRouterSpecText,
  ROUTER_ID_PATTERN,
  routerSpecFor,
  routerSpecYaml,
  type GatewayConfig,
  type RouterConfig,
  type RouterSpec,
} from "./config.js";
import type { RouterModelStore } from "./router_models.js";

// A spec as written: its YAML text, kept so it reads back as it was sent.
export type StoredRouterSpec = RouterSpec & { text: string };

export class RouterSpecStore {
  private readonly saved = new Map<string, StoredRouterSpec>();

  constructor(
    private readonly db: Database,
    // Specs from files, which the API cannot change.
    readonly files: ReadonlyMap<string, StoredRouterSpec> = new Map(),
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS router_specs (
      router_id TEXT PRIMARY KEY,
      spec TEXT NOT NULL
    )`);
    const rows = db.query<{ router_id: string; spec: string }, []>("SELECT router_id, spec FROM router_specs").all();
    for (const row of rows) {
      try {
        this.saved.set(row.router_id, storedSpec(row.router_id, row.spec));
      } catch (error) {
        // A spec this version no longer accepts is not served; saving it again
        // with a fix serves it.
        console.warn(
          "dari-gateway saved router spec is not served",
          JSON.stringify({ router: row.router_id, error: error instanceof Error ? error.message : String(error) }),
        );
      }
    }
  }

  /** The spec served for a router id: a saved one, else a file's. */
  get(routerId: string): (StoredRouterSpec & { source: "saved" | "file" }) | undefined {
    const saved = this.saved.get(routerId);
    if (saved !== undefined) return { ...saved, source: "saved" };
    const file = this.files.get(routerId);
    return file === undefined ? undefined : { ...file, source: "file" };
  }

  /** The ids of every spec, saved or from a file. */
  ids(): string[] {
    return [...new Set([...this.files.keys(), ...this.saved.keys()])];
  }

  /** The ids with a saved spec. */
  savedIds(): string[] {
    return [...this.saved.keys()].sort();
  }

  save(routerId: string, spec: StoredRouterSpec): void {
    this.db
      .query(
        `INSERT INTO router_specs (router_id, spec) VALUES (?, ?)
         ON CONFLICT (router_id) DO UPDATE SET spec = excluded.spec`,
      )
      .run(routerId, spec.text);
    this.saved.set(routerId, spec);
  }

  /** Forget a saved spec; returns it, or undefined when there was none. */
  remove(routerId: string): StoredRouterSpec | undefined {
    const saved = this.saved.get(routerId);
    this.db.query("DELETE FROM router_specs WHERE router_id = ?").run(routerId);
    this.saved.delete(routerId);
    return saved;
  }
}

function storedSpec(routerId: string, text: string): StoredRouterSpec {
  return { ...parseRouterSpec(routerId, parseRouterSpecText(text)), text };
}

/**
 * Read each `*.yaml` or `*.yml` spec in `dir` as the router its file name
 * names: `opus-deepseek.yaml` is router `opus-deepseek`.
 */
export async function loadRouterSpecDirectory(dir: string): Promise<Map<string, StoredRouterSpec>> {
  const specs = new Map<string, StoredRouterSpec>();
  for (const file of readdirSync(dir).sort()) {
    const extension = extname(file);
    if (extension !== ".yaml" && extension !== ".yml") continue;
    const routerId = basename(file, extension);
    if (!ROUTER_ID_PATTERN.test(routerId)) {
      throw new Error(`Router spec ${file}: a router id may use only letters, digits, "-" and "_".`);
    }
    if (specs.has(routerId)) throw new Error(`Router spec ${file}: router ${routerId} has two spec files.`);
    try {
      specs.set(routerId, storedSpec(routerId, await Bun.file(join(dir, file)).text()));
    } catch (error) {
      throw new Error(`Router spec ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return specs;
}

export type ServedRouters = {
  config: GatewayConfig;
  routerModels: RouterModelStore;
  routerSpecs: RouterSpecStore;
};

/** The router served under an id: its spec, else the config file's with its saved model lists. */
export function servedRouter(routers: ServedRouters, routerId: string): RouterConfig | undefined {
  const spec = routers.routerSpecs.get(routerId);
  if (spec !== undefined) return spec.router;
  const configured = routers.config.routers[routerId];
  return configured === undefined ? undefined : routers.routerModels.served(routerId, configured);
}

/** Every router id the gateway serves: the config file's first. */
export function servedRouterIds(routers: ServedRouters): string[] {
  const configured = Object.keys(routers.config.routers);
  return [...configured, ...routers.routerSpecs.ids().filter((id) => !configured.includes(id)).sort()];
}

export const ROUTERS_ROUTE = /^\/v1\/routers(?:\/([^/]+))?$/;

// Hosted Dari's limit on a spec's text.
const SPEC_TEXT_MAX_LENGTH = 200_000;

/**
 * Serve router specs. The caller authenticates the gateway key.
 *
 * - `GET /v1/routers` lists `{ routers: [{ id, name, source }] }`, where
 *   `source` is `saved` for a spec saved through this API and `config` for a
 *   router from the config file or a spec file.
 * - `GET /v1/routers/<id>` answers the router's spec as YAML: a saved or
 *   file spec as written, a config file router as the spec it amounts to.
 * - `PUT /v1/routers/<id>` with `{ "spec_yaml": "<YAML>" }` (or a JSON
 *   `{ "spec": {...} }`) saves the spec and serves it at once, in place of any
 *   router of that id, answering `{ id, name }`.
 * - `DELETE /v1/routers/<id>` forgets a saved spec, answering `{ id, name }`;
 *   a router of that id from the config file serves again.
 *
 * `changed` runs after each save or removal. Returns null for any other path.
 */
export async function handleRouterSpecsRequest(
  request: Request,
  deps: ServedRouters & { changed: (routerId: string) => void },
): Promise<Response | null> {
  const route = ROUTERS_ROUTE.exec(new URL(request.url).pathname);
  if (route === null) return null;
  try {
    const routerId = route[1];
    if (routerId === undefined) {
      if (request.method !== "GET") throw new HttpError(405, "Method not allowed.", "method_not_allowed");
      const routers = servedRouterIds(deps).map((id) => {
        const spec = deps.routerSpecs.get(id);
        return { id, name: spec?.name ?? id, source: spec?.source === "saved" ? "saved" : "config" };
      });
      return Response.json({ routers }, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "GET") {
      const spec = deps.routerSpecs.get(routerId);
      const router = servedRouter(deps, routerId);
      if (router === undefined) throw routerNotFound(routerId);
      return new Response(spec?.text ?? routerSpecYaml(routerSpecFor(routerId, router)), {
        headers: { "Content-Type": "application/yaml; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (request.method === "PUT") {
      if (!ROUTER_ID_PATTERN.test(routerId)) {
        throw new HttpError(400, `Router id "${routerId}" may use only letters, digits, "-" and "_".`, "invalid_request_error");
      }
      const spec = await requestedSpec(request, routerId);
      deps.routerSpecs.save(routerId, spec);
      deps.changed(routerId);
      return Response.json({ id: routerId, name: spec.name });
    }
    if (request.method === "DELETE") {
      if (deps.routerSpecs.get(routerId)?.source !== "saved") {
        if (servedRouter(deps, routerId) === undefined) throw routerNotFound(routerId);
        throw new HttpError(
          400,
          `Router ${routerId} comes from the gateway's config files; edit them to change or remove it.`,
          "router_not_saved",
        );
      }
      const removed = deps.routerSpecs.remove(routerId)!;
      deps.changed(routerId);
      return Response.json({ id: routerId, name: removed.name });
    }
    throw new HttpError(405, "Method not allowed.", "method_not_allowed");
  } catch (error) {
    return errorResponse(error);
  }
}

function routerNotFound(routerId: string): HttpError {
  return new HttpError(404, `Router ${routerId} is not configured on this gateway.`, "router_not_found");
}

async function requestedSpec(request: Request, routerId: string): Promise<StoredRouterSpec> {
  const body: unknown = await request.json().catch(() => null);
  const payload = body !== null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const extra = Object.keys(payload).filter((key) => key !== "spec" && key !== "spec_yaml");
  if (extra.length > 0 || (payload.spec === undefined) === (payload.spec_yaml === undefined)) {
    throw new HttpError(400, 'Send a JSON body with "spec_yaml", the spec\'s YAML text, or "spec".', "invalid_request_error");
  }
  if (payload.spec_yaml !== undefined && (typeof payload.spec_yaml !== "string" || payload.spec_yaml.length > SPEC_TEXT_MAX_LENGTH)) {
    throw new HttpError(400, `spec_yaml must be text of at most ${SPEC_TEXT_MAX_LENGTH} characters.`, "invalid_request_error", "spec_yaml");
  }
  const text = typeof payload.spec_yaml === "string"
    ? payload.spec_yaml
    : routerSpecYaml(payload.spec);
  try {
    return storedSpec(routerId, text);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error), "invalid_router_spec");
  }
}
