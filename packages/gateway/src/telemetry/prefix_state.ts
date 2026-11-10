import {
  type ReasoningEffort,
  type RouterPrefixHit,
  type RoutingDecision,
} from "@mupt-ai/dari-router/policy-engine";
import {
  extendInteractionChain,
  extendInteractionLooseChain,
} from "../context/interaction_fingerprint.js";
import type {
  InteractionOutput,
  InteractionRequest,
  InteractionUsage,
  ProviderIdentity,
} from "../interaction/types.js";
import { gatewayPlatform, type PrefixStateWrite } from "../platform/platform.js";
import { tokenCount } from "./ingest_values.js";

export type CompletedPrefixHit = Omit<RouterPrefixHit, "updated_at"> & {
  lease_depth: number;
};

export function buildCompletedPrefixHit(args: {
  request: InteractionRequest;
  output: InteractionOutput;
  model: string;
  nextModel: string | null;
  nextReasoningEffort: ReasoningEffort | null;
  reasoningBucket: ReasoningEffort | null;
  // Countdown persisted by lease-aware routing; null when deciding per turn.
  leaseTurnsRemaining: number | null;
  reason: string | null;
  chain: string[];
  looseChain: readonly string[];
  target: ProviderIdentity;
  conversationId: string;
  leaseDepth: number;
  providerBlockDepth: number;
  fingerprints: { tool_choice_fp: string; response_format_fp: string };
  usage: InteractionUsage;
  benchmarkReplayDepth: number;
}): CompletedPrefixHit | null {
  if (args.chain.length === 0) return null;
  const outputExtension = extendOutputPrefix({
    request: args.request,
    output: args.output,
    chain: args.chain,
    target: args.target,
  });
  const hash = outputExtension.at(-1);
  if (hash === undefined) return null;
  const inputTokens = tokenCount(args.usage?.input) ?? 0;
  const cacheReadTokens = tokenCount(args.usage?.cacheRead) ?? 0;
  const cacheWriteTokens = tokenCount(args.usage?.cacheWrite) ?? 0;
  return {
    hash,
    loose_hash: looseOutputHash(args.looseChain, args.output, args.request.sourceProtocol),
    conversation_id: args.conversationId,
    model: args.model,
    provider: args.target.provider,
    next_model: args.nextModel,
    next_reasoning_effort: args.nextReasoningEffort,
    message_depth: args.chain.length + outputExtension.length,
    lease_depth: args.leaseDepth,
    provider_block_depth: args.providerBlockDepth,
    prompt_anchor_depth: args.chain.length,
    input_tokens: inputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    prompt_tokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    benchmark_replay_depth: args.benchmarkReplayDepth,
    tool_choice_fp: args.fingerprints.tool_choice_fp,
    response_format_fp: args.fingerprints.response_format_fp,
    reasoning_bucket: args.reasoningBucket,
    lease_turns_remaining: args.leaseTurnsRemaining,
    reason: args.reason,
  };
}

export function leaseCountdownForPrefix(args: {
  served: RoutingDecision | null;
  next: RoutingDecision | null;
}): number | null {
  const granted = args.next ?? args.served;
  const remaining = granted?.leaseTurnsRemaining;
  if (remaining === undefined || remaining === null) return null;
  const servedGrantedPair =
    args.next === null ||
    (args.served !== null &&
      args.served.selectedModel === args.next.selectedModel &&
      args.served.reasoningEffort === args.next.reasoningEffort);
  return servedGrantedPair ? remaining : remaining + 1;
}

export async function reportPendingLease(args: {
  routerId: string;
  conversationId: string;
  // Conversation depth this write was decided at; the platform fences out
  // writes decided shallower than the last applied one.
  decidedAtDepth: number;
  lease: {
    model: string;
    reasoningEffort: string;
    turns: number;
    reason: string;
    outputText: string | null;
  } | null;
}): Promise<void> {
  try {
    await gatewayPlatform().writePendingLease({
      router_id: args.routerId,
      conversation_id: args.conversationId,
      decided_at_depth: args.decidedAtDepth,
      pending_lease: args.lease === null
        ? null
        : {
            model: args.lease.model,
            reasoning_effort: args.lease.reasoningEffort,
            turns: args.lease.turns,
            reason: args.lease.reason,
            output_text: args.lease.outputText,
          },
    });
  } catch (error) {
    console.error("pending-lease write failed", error);
  }
}

export function prefixEntryForIngest(hit: CompletedPrefixHit): Record<string, unknown> {
  const { hash, loose_hash, ...entry } = hit;
  return { prefix_hash: hash, loose_prefix_hash: loose_hash ?? null, ...entry };
}

// Loose-tier hash for the entry: the request's loose chain extended with the
// reply. Best-effort — a null loose hash only forfeits echo-mutation
// tolerance for this one turn, never the entry itself.
function looseOutputHash(
  looseChain: readonly string[],
  output: InteractionOutput,
  sourceProtocol: InteractionRequest["sourceProtocol"],
): string | null {
  const lastHash = looseChain[looseChain.length - 1];
  if (lastHash === undefined) return null;
  try {
    return extendInteractionLooseChain(lastHash, output, sourceProtocol).at(-1) ?? null;
  } catch (error) {
    console.error("loose prefix extension failed", error);
    return null;
  }
}

function extendOutputPrefix(args: {
  request: InteractionRequest;
  output: InteractionOutput;
  chain: string[];
  target: ProviderIdentity;
}): string[] {
  const lastHash = args.chain[args.chain.length - 1];
  return extendInteractionChain(lastHash, args.output, args.target, {
    includeItemIds: carriesItemIds(args.request),
    sourceProtocol: args.request.sourceProtocol,
  });
}

// Codex strips provider-returned item ids from stateless HTTP requests unless
// its ItemIds feature is active. Existing input ids are the only request-side
// evidence that newly returned ids will be carried into the next turn.
function carriesItemIds(request: InteractionRequest): boolean {
  return request.items.some((item) => "id" in item && typeof item.id === "string" && item.id.length > 0);
}

export async function reportPrefixState(write: PrefixStateWrite): Promise<void> {
  try {
    await gatewayPlatform().writePrefixState(write);
  } catch (error) {
    console.error("routing prefix-state write failed", error);
  }
}
