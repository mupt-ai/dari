import { createHash } from "node:crypto";

import type { ReasoningEffort } from "@mupt-ai/dari-router/policy-engine";
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

/* What Codex needs to parse an entry it fetched itself: it rejects the whole
   catalog over a null web-search type, leaving /model empty, so the entry
   names one, and the two nullable fields it may not accept as null are left
   out. The `dari` launchers make the same changes to the catalog they hand
   Codex; they read the nulls first to decide whether to turn web search off. */
function codexReadable(entry: Record<string, unknown>): Record<string, unknown> {
  const { tool_mode, multi_agent_version, ...rest } = entry;
  return {
    ...rest,
    web_search_tool_type: entry.web_search_tool_type ?? "text",
    ...(tool_mode === null ? {} : { tool_mode }),
    ...(multi_agent_version === null ? {} : { multi_agent_version }),
  };
}

/* `dari/routing` comes first while the router may autoroute (the Codex
   launcher patches it); each enabled model follows as `dari/model/<id>` so
   Codex's /model menu can switch to it. The `dari` launchers build every
   agent's model menu from this list. `remote_compaction` tells the
   launcher which Codex provider compaction protocol the router accepts.
   `direct` is a catalog for Codex's own fetch (its `model_catalog_url`),
   which nothing patches on the way: `codex_direct` tells `dari setup codex`
   that this gateway serves one, so it can point Codex at the URL instead of
   a snapshot that goes stale when the router's models change. */
export function codexModelsResponse(
  router: Pick<ResolvedRouter, "enabled_models" | "model_configs" | "allow_long_context" | "autorouting_enabled" | "routing_listed" | "native_compaction" | "model_thinking_levels">,
  imageInputFor: (model: string) => boolean,
  nativeCompactionFor: (model: string) => boolean = () => false,
  direct = false,
): Record<string, unknown> {
  const remoteCompaction = router.native_compaction === true && router.enabled_models.some(nativeCompactionFor);
  const models = codexCatalogEntries(router, imageInputFor);
  return {
    remote_compaction: remoteCompaction ? "v2" : "unsupported",
    ...(direct ? { codex_direct: true } : {}),
    models: direct ? models.map(codexReadable) : models,
  };
}

/* A version of the list Codex's /model menu shows: it changes when a model
   is added or removed, dari/routing comes or goes, or a model's thinking
   levels or default change. Sent as
   `X-Models-Etag` on the catalog and on Codex's responses, it makes a running
   Codex re-read the catalog after the first turn that sees a new value,
   instead of on its next timed refresh. Codex reads it only from a successful
   response; a refused stale pick carries the menu hint instead. */
export function codexModelsEtag(
  router: Pick<ResolvedRouter, "enabled_models" | "model_configs" | "allow_long_context" | "autorouting_enabled" | "routing_listed" | "model_thinking_levels">,
): string {
  const menu = codexCatalogEntries(router, () => false).map((entry) => {
    const levels = (entry.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort);
    return `${entry.slug} ${entry.default_reasoning_level ?? ""} ${levels.join(",")}`;
  });
  return createHash("sha256").update(menu.join("\n")).digest("hex").slice(0, 16);
}

function codexCatalogEntries(
  router: Pick<ResolvedRouter, "enabled_models" | "model_configs" | "allow_long_context" | "autorouting_enabled" | "routing_listed" | "model_thinking_levels">,
  imageInputFor: (model: string) => boolean,
): Record<string, unknown>[] {
  return [
    ...(router.autorouting_enabled === false || router.routing_listed === false ? [] : [codexCatalogEntry({
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
        ...codexThinkingChoices(router, model),
      })
    ),
  ];
}

const codexEffort = (effort: ReasoningEffort): string => effort === "off" ? "none" : effort;

/* The thinking levels a pinned `dari/model/<id>` actually serves, so Codex's
   /model and /effort menus offer only levels that run as picked. The gateway
   keeps a requested level only when the router enables it for the model and
   the model supports it (`clampRequestedEffort`, and candidate compatibility
   in the router package); otherwise it drops the level and serves the
   model's default if the router enables that, else the router's first
   enabled level (`pickCandidate`). The menu shows that same set and default.
   A model the router sets no levels for serves every level it supports. */
function codexThinkingChoices(
  router: Pick<ResolvedRouter, "model_configs" | "model_thinking_levels">,
  model: string,
): Pick<CodexCatalogEntry, "reasoningLevels" | "defaultReasoningLevel"> {
  const config = router.model_configs?.[model];
  const supported = config?.supported_thinking_levels;
  if (!supported) {
    const fallback = config?.default_thinking_level;
    return { defaultReasoningLevel: fallback ? codexEffort(fallback) : fallback };
  }
  const configured = router.model_thinking_levels?.[model] ?? supported;
  const served = configured.filter((level) => supported.includes(level));
  const modelDefault = config.default_thinking_level;
  const fallback = modelDefault && served.includes(modelDefault) ? modelDefault : served[0];
  return {
    // Codex lists levels in the order given: keep the model's low-to-high order.
    reasoningLevels: supported.filter((level) => served.includes(level)).map(codexEffort),
    defaultReasoningLevel: fallback ? codexEffort(fallback) : null,
  };
}
