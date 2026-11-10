import type { HardCapability, ReasoningEffort } from "@mupt-ai/dari-router/policy-engine";

export type {
  ProviderIdentity,
  ProviderContinuationState,
} from "@mupt-ai/dari-router/protocols";
import type {
  ProviderContinuationState,
  ProviderIdentity,
} from "@mupt-ai/dari-router/protocols";

export type SourceProtocol = "anthropic_messages" | "openai_chat" | "openai_responses";
export type AgentRequestClass =
  | "main" | "subagent" | "workflow" | "auxiliary" | "compaction" | "side_reply" | "unknown";

export type AgentRequestContext = {
  requestClass: AgentRequestClass;
  agentId?: string;
  parentAgentId?: string;
  agentType?: string;
};

export function isBackgroundRequest(request: InteractionRequest): boolean {
  return request.agentContext?.requestClass === "auxiliary"
    || request.agentContext?.requestClass === "compaction"
    || request.agentContext?.requestClass === "side_reply";
}

export type InteractionRequestPurpose =
  | "memory_extraction"
  | "tool_continuation";

export type InteractionResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
      description?: string;
    };

export type InteractionText = {
  type: "text";
  text: string;
  annotations?: Array<Record<string, unknown>>;
};

export type InteractionImage = {
  type: "image";
  url: string;
  detail?: "auto" | "low" | "high" | "original";
};

/** A base64-encoded PDF. Only Anthropic Messages targets accept documents. */
export type InteractionDocument = {
  type: "document";
  mimeType: "application/pdf";
  data: string;
};

export type InteractionToolReference = {
  type: "tool_reference";
  toolName: string;
};

export type InteractionContent = InteractionText | InteractionImage | InteractionDocument | InteractionToolReference;

export type InteractionMessage = {
  type: "message";
  id?: string;
  clientTurnId?: string;
  role: "system" | "developer" | "user" | "assistant";
  content: InteractionContent[];
  contentShape: "string" | "parts" | "null" | "absent";
  phase?: "commentary" | "final_answer";
  source?: ProviderIdentity;
};

export type InteractionReasoning = {
  type: "reasoning";
  id?: string;
  summary: string[];
  content: string[];
  source?: ProviderIdentity;
  continuation?: ProviderContinuationState;
};

export type ToolKind = "function" | "custom";

export type InteractionToolCall = {
  type: "tool_call";
  id?: string;
  callId: string;
  kind: ToolKind;
  name: string;
  namespace?: string;
  input?: string | Record<string, unknown>;
  status?: "in_progress" | "completed" | "incomplete";
};

export type InteractionToolResult = {
  type: "tool_result";
  id?: string;
  callId: string;
  kind: ToolKind;
  name?: string;
  output: string | InteractionContent[] | null;
  outputShape: "string" | "parts" | "null" | "absent";
  isError?: boolean;
  loadedTools?: string[];
};

export type InteractionReasoningConfiguration = {
  type: "reasoning_configuration";
  effort: ReasoningEffort;
};

export type InteractionHostedToolCall = {
  type: "hosted_tool_call";
  id: string;
  tool: "web_search" | "server_tool_use" | "tool_search";
  providerType: "web_search_call" | "server_tool_use" | "tool_search_result";
  status?: "in_progress" | "searching" | "completed" | "incomplete" | "failed";
  payload: Record<string, unknown>;
  source?: ProviderIdentity;
  serverToolUseId?: string;
  serverToolName?: string;
  serverToolInput?: Record<string, unknown>;
  serverToolResult?: InteractionToolReference[];
};

export type InteractionItem =
  | InteractionMessage
  | InteractionReasoning
  | InteractionToolCall
  | InteractionToolResult
  | InteractionReasoningConfiguration
  | InteractionHostedToolCall;

export type InteractionOutputItem =
  | InteractionMessage
  | InteractionReasoning
  | InteractionToolCall
  | InteractionHostedToolCall;

export type ServerToolKind =
  | "bash_20250124"
  | "text_editor_20250124"
  | "tool_search_tool_20250919"
  | "tool_search_tool_regex_20250919"
  | "tool_search_tool_regex"
  | "tool_search_tool_regex_20251119"
  | "tool_search_tool_bm25"
  | "tool_search_tool_bm25_20251119";

export type ClientTool = {
  kind: "client_tool";
  name: string;
  type: "bash_20250124" | "text_editor_20250124";
  description?: string;
};

export type FunctionTool = {
  kind: "function";
  name: string;
  namespace?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  deferLoading?: boolean;
};

export type CustomTool = {
  kind: "custom";
  name: string;
  namespace?: string;
  description?: string;
  format?: Record<string, unknown>;
};

export type HostedTool = {
  kind: "hosted";
  type: "web_search" | "web_search_preview";
  config: Record<string, unknown>;
};

export type ServerTool = {
  kind: "server_tool";
  name: string;
  type: ServerToolKind;
  description?: string;
};

export type InteractionTool = FunctionTool | CustomTool | HostedTool | ServerTool | ClientTool;

export type InteractionToolChoice =
  | "none"
  | "auto"
  | "required"
  | "any"
  | {
      kind: ToolKind;
      name: string;
      namespace?: string;
    }
  | {
      kind: "hosted";
      type: HostedTool["type"];
    };

export type GenerationControls = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stop?: string | string[];
};

export type ReasoningControls = {
  // Effective effort after applying any Responses configuration_update items.
  effort?: ReasoningEffort;
  // The unchanged request-level effort sent to the provider. GPT-6 uses
  // positional configuration updates to change effort without rewriting the
  // hidden prompt prefix derived from this value.
  baseEffort?: ReasoningEffort;
  hasConfigurationUpdate?: boolean;
  enabled?: boolean;
  budgetTokens?: number;
};

// Anthropic's server-side safeguards (Claude Code auto mode's classifier) and
// the client's betas that pair with them, forwarded verbatim.
export type AnthropicSafeguards = {
  safeguards: unknown[];
  betas: string[];
};

export type InteractionRequest = {
  sourceProtocol: SourceProtocol;
  requestPurpose?: InteractionRequestPurpose;
  agentContext?: AgentRequestContext;
  // Claude Code's own user agent; Anthropic gates subscription models on it.
  claudeCodeUserAgent?: string;
  // Muse Code's own x-client-id, which Meta attributes its requests by.
  museCodeClientId?: string;
  anthropicSafeguards?: AnthropicSafeguards;
  model?: string;
  instructions?: string;
  items: InteractionItem[];
  tools: InteractionTool[];
  toolChoice?: InteractionToolChoice;
  parallelToolCalls?: boolean;
  generation: GenerationControls;
  reasoning?: ReasoningControls;
  responseFormat?: InteractionResponseFormat;
  promptCacheKey?: string;
  stream: boolean;
  metadata?: Record<string, unknown>;
  user?: string;
};

export type InteractionUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  // "provider" when cost.total is the provider's billed amount rather than a
  // price from the model's rates.
  costSource?: "provider";
};

export type InteractionOutput = {
  responseId?: string;
  createdAtMs: number;
  source: ProviderIdentity;
  items: InteractionOutputItem[];
  usage: InteractionUsage;
  stopReason: "stop" | "length" | "tool_use" | "error" | "aborted";
  errorMessage?: string;
  // Anthropic's `safeguard_results`, returned to the client verbatim.
  safeguardResults?: unknown[];
};
