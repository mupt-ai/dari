import { bearerToken } from "../http/auth.js";
import { errorResponse } from "../http/errors.js";
import { resolveRouter } from "../strategies/routing.js";
import type { ResolvedRouter } from "../types.js";

/**
 * Muse Code fetches its model list from its base URL's origin
 * (`/muse-code/models`) before its first request. A list of only the router's
 * models lets Muse Code pick from them and start on the first; `dari/routing`
 * leads it only on the Autorouting plan.
 */
export function museCodeModelsResponse(
  router: Pick<ResolvedRouter, "enabled_models" | "autorouting_enabled">,
): Record<string, unknown> {
  const ids = [
    ...(router.autorouting_enabled === false ? [] : ["dari/routing"]),
    ...router.enabled_models.map((model) => `dari/model/${model}`),
  ];
  return {
    data: ids.map((id, index) => ({
      id,
      display_label: id === "dari/routing" ? "Dari Routing" : id.slice("dari/model/".length),
      is_default: index === 0,
    })),
  };
}

export async function handleMuseCodeModels(request: Request, routerId: string): Promise<Response> {
  try {
    // Only Muse Code fetches this list, so its plans apply even without a Meta key.
    const router = await resolveRouter({ routerId, apiKey: bearerToken(request.headers), clientHarness: "muse_code" });
    return Response.json(museCodeModelsResponse(router), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
