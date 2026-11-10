// Stable framework API. Advanced policy-engine and protocol helpers live in
// explicit subpath exports so the root remains discoverable and refactorable.
export {
  createRouter,
} from "./framework_router.js";
export {
  createAutoRouter,
} from "./auto_router.js";
export {
  createGatewayExecutor,
} from "./gateway_executor.js";

export type {
  RouterProtocol,
  RouterTextContent,
  RouterImageContent,
  RouterContent,
  RouterMessageItem,
  RouterToolCallItem,
  RouterToolResultItem,
  RouterHostedToolCallStatus,
  RouterHostedToolCallItem,
  RouterReasoningItem,
  RouterInputItem,
  RouterTool,
  RouterToolChoice,
  RouterResponseFormat,
  RouterRequest,
  RouterModelCapabilities,
  RouterModel,
  RouterCandidate,
  RoutingPolicyInput,
  RoutingPolicyDecision,
  RoutingPolicy,
  RouterSelection,
  RouterUsage,
  RouterFinishReason,
  RouterOutputText,
  RouterOutputToolCall,
  RouterOutputReasoning,
  RouterOutputHostedToolCall,
  RouterOutputItem,
  RouterCompletion,
  RouterStreamEvent,
  RouterExecutorResult,
  RouterExecutorInput,
  RouterExecutor,
  CreateRouterOptions,
  Router,
  RouterLease,
  LeaseStore,
  RouterHookResult,
  RouterHooks,
  RouterFallbackConfig,
} from "./framework_types.js";
export type { CreateAutoRouterOptions } from "./auto_router.js";
export type { CreateGatewayExecutorOptions } from "./gateway_executor.js";
export type { ReasoningEffort } from "./types.js";
export { RouterFrameworkError } from "./framework_error.js";
export type { RouterFrameworkErrorKind } from "./framework_error.js";
