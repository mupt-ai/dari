import type { HardCapability } from "@mupt-ai/dari-router/policy-engine";
import type { AnthropicWebSearchToolType, InteractionItem, InteractionRequest, ServerTool } from "./types.js";

export function isAnthropicWebSearchToolType(type: string): type is AnthropicWebSearchToolType {
  return /^web_search_\d{8}$/.test(type);
}

// The request's Anthropic web search tool. Anthropic runs it inside the Claude
// API, so only a Claude model there can serve the request.
export function anthropicWebSearchTool(
  request: Pick<InteractionRequest, "tools">,
): ServerTool | undefined {
  return request.tools.find((tool): tool is ServerTool =>
    tool.kind === "server_tool" && isAnthropicWebSearchToolType(tool.type)
  );
}

export function requiredCapabilitiesFor(
  request: Pick<InteractionRequest, "items" | "responseFormat" | "toolChoice" | "tools">
): HardCapability[] {
  const capabilities = new Set<HardCapability>();
  if (request.items.some(itemHasImage)) capabilities.add("image_input");
  if (request.items.some((item) => item.type === "reasoning_configuration")) {
    capabilities.add("reasoning_configuration_update");
  }
  if (request.responseFormat !== undefined && request.responseFormat.type !== "text") capabilities.add("structured_output");
  if (
    request.tools.some((tool) => tool.kind === "hosted")
    || request.items.some(requiresWebSearch)
    || (typeof request.toolChoice === "object" && request.toolChoice.kind === "hosted")
  ) {
    capabilities.add("openai_hosted_web_search");
  }
  if (anthropicWebSearchTool(request) !== undefined) capabilities.add("anthropic_web_search");
  return [...capabilities];
}

function requiresWebSearch(item: InteractionItem): boolean {
  return item.type === "hosted_tool_call" && item.tool === "web_search";
}

export function requestHasDocument(request: Pick<InteractionRequest, "items">): boolean {
  return request.items.some((item) => {
    const parts = item.type === "message" ? item.content : item.type === "tool_result" ? item.output : null;
    return Array.isArray(parts) && parts.some((part) => part.type === "document");
  });
}

function itemHasImage(item: InteractionItem): boolean {
  if (item.type === "message") return item.content.some((part) => part.type === "image");
  return item.type === "tool_result" && Array.isArray(item.output) && item.output.some((part) => part.type === "image");
}
