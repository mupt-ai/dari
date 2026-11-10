import type { ResolvedRouter } from "../types.js";
import { CANONICAL_ROUTER_MODEL, explicitModelSlug } from "../protocol/input/router_model.js";
import { effectiveContextWindow } from "../models/context_limits.js";
import { modelSupportsHostedWebSearch } from "../providers/model_capabilities.js";

const DEFAULT_CODEX_CONTEXT_WINDOW = 128_000;

function codexRouterContextWindow(router: Pick<ResolvedRouter, "enabled_models" | "model_configs" | "allow_long_context">): number {
  const windows = router.enabled_models.map((model) => {
    const configured = effectiveContextWindow(router.model_configs?.[model], router.allow_long_context === true);
    return typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_CODEX_CONTEXT_WINDOW;
  });
  return windows.length > 0 ? Math.max(...windows) : DEFAULT_CODEX_CONTEXT_WINDOW;
}

function codexRouterSupportsHostedWebSearch(
  router: Pick<ResolvedRouter, "enabled_models" | "model_configs">
): boolean {
  return router.enabled_models.some((model) => {
    const config = router.model_configs?.[model];
    return config ? modelSupportsHostedWebSearch({ model: config }) : false;
  });
}

type CodexCatalogEntry = {
  slug: string;
  displayName: string;
  description: string;
  priority: number;
  contextWindow: number;
  hostedWebSearch: boolean;
  imageInput: boolean;
  reasoningLevels?: string[];
  defaultReasoningLevel?: string | null;
};

function codexCatalogEntry(args: CodexCatalogEntry): Record<string, unknown> {
  return {
    slug: args.slug,
    display_name: args.displayName,
    description: args.description,
    default_reasoning_level: args.defaultReasoningLevel ?? null,
    supported_reasoning_levels: (args.reasoningLevels ?? []).map((effort) => ({
      effort,
      description: `${effort} thinking`,
    })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: args.priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions:
      "You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.",
    model_messages: null,
    include_skills_usage_instructions: false,
    // Codex 0.144 requires the legacy field; current main reads the renamed field below.
    supports_reasoning_summaries: false,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: args.hostedWebSearch ? "text" : null,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: args.contextWindow,
    max_context_window: args.contextWindow,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: args.imageInput ? ["text", "image"] : ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: args.slug,
    tool_mode: null,
    multi_agent_version: null,
  };
}

/* `dari/routing` comes first while the router may autoroute (the Codex
   launcher patches it); each enabled model follows as `dari/model/<id>` so
   Codex's /model menu can switch to it. The `dari` launchers build every
   agent's model menu from this list. */
export function codexModelsResponse(
  router: Pick<ResolvedRouter, "enabled_models" | "model_configs" | "allow_long_context" | "autorouting_enabled">,
  imageInputFor: (model: string) => boolean
): Record<string, unknown> {
  return {
    models: [
      ...(router.autorouting_enabled === false ? [] : [codexCatalogEntry({
        slug: CANONICAL_ROUTER_MODEL,
        displayName: "Dari Routing",
        description: "Routes Codex HTTP Responses requests through the configured Dari model router.",
        priority: 0,
        contextWindow: codexRouterContextWindow(router),
        hostedWebSearch: codexRouterSupportsHostedWebSearch(router),
        imageInput: router.enabled_models.some(imageInputFor),
      })]),
      ...router.enabled_models.map((model, index) =>
        codexCatalogEntry({
          slug: explicitModelSlug(model),
          displayName: model,
          description: `Serves ${model} directly, without routing.`,
          priority: index + 1,
          contextWindow: codexRouterContextWindow({ ...router, enabled_models: [model] }),
          hostedWebSearch: codexRouterSupportsHostedWebSearch({ ...router, enabled_models: [model] }),
          imageInput: imageInputFor(model),
          reasoningLevels: router.model_configs?.[model]?.supported_thinking_levels
            ?.map((effort) => effort === "off" ? "none" : effort),
          defaultReasoningLevel: router.model_configs?.[model]?.default_thinking_level === "off"
            ? "none" : router.model_configs?.[model]?.default_thinking_level,
        })
      ),
    ],
  };
}
