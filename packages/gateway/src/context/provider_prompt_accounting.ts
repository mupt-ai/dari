import { constants as zlibConstants, inflateSync } from "node:zlib";

import {
  isRecord,
  stableStringify,
  type CandidatePromptAccounting,
} from "@mupt-ai/dari-router/policy-engine";

import { toolsByWireName } from "../interaction/tool_identity.js";
import type {
  InteractionContent,
  InteractionRequest,
  ProviderIdentity,
} from "../interaction/types.js";
import { buildContext } from "../providers/pi_context.js";
import { isOpenAIResponsesApi } from "../providers/model_capabilities.js";
import type { InteractionPrefixContext } from "./interaction_fingerprint.js";

type PromptMetrics = {
  blockDepth: number;
  serializedChars: number;
};

const ACCOUNTING_IMAGE_URL = "data:image/png;base64,AA==";
const IMAGE_ESTIMATED_TOKENS = {
  low: 512,
  auto: 1024,
  high: 2048,
  original: 2048,
} as const;
const CHARS_PER_ESTIMATED_TOKEN = 4;
// Anthropic bills each PDF page as its text plus a page image: 1,500-3,000
// tokens. Use the top of that range so a long PDF cannot look like it fits.
const PDF_ESTIMATED_TOKENS_PER_PAGE = 3000;
const PDF_PAGE_PATTERN = /\/Type\s*\/Page(?![a-zA-Z])/g;
const PDF_OBJECT_STREAM_START = /\/Type\s*\/ObjStm[\s\S]*?stream\r?\n/g;
// Object streams hold small dictionaries. The cap is total inflated bytes per
// PDF, so a compression bomb in a request costs at most this much memory.
const PDF_OBJECT_STREAM_INFLATE_BUDGET = 4 * 1024 * 1024;

function estimatedPdfPages(base64: string): number {
  const bytes = Buffer.from(base64, "base64");
  // latin1 maps each byte to one character, so string offsets are byte offsets.
  const pdf = bytes.toString("latin1");
  const visible = pdf.match(PDF_PAGE_PATTERN)?.length ?? 0;
  if (visible > 0) return visible;
  // PDF 1.5+ may keep every page dictionary in compressed object streams.
  let hidden = 0;
  let budget = PDF_OBJECT_STREAM_INFLATE_BUDGET;
  for (const match of pdf.matchAll(PDF_OBJECT_STREAM_START)) {
    const start = match.index + match[0].length;
    const end = pdf.indexOf("endstream", start);
    if (end === -1 || budget <= 0) break;
    try {
      const objects = inflateSync(bytes.subarray(start, end), {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: budget,
      });
      budget -= objects.length;
      hidden += objects.toString("latin1").match(PDF_PAGE_PATTERN)?.length ?? 0;
    } catch (error) {
      // Over budget: stop. Another filter or bad data: count what is readable.
      if (error instanceof RangeError) break;
    }
  }
  return Math.max(1, hidden);
}

// Cost and cache-lookback estimates are candidate-specific because compatible
// continuation state and provider serialization can change what each model
// sees.
export function providerPromptAccounting(args: {
  request: InteractionRequest;
  prefix: InteractionPrefixContext;
  targetsByModel: ReadonlyMap<string, ProviderIdentity>;
}): CandidatePromptAccounting {
  const fullByModel = new Map<string, PromptMetrics>();
  const prefixCharsByModelAndItem = new Map<string, number>();

  const targetFor = (model: string): ProviderIdentity => {
    const target = args.targetsByModel.get(model);
    if (!target) {
      throw new Error(`missing provider target for ${model}`);
    }
    return target;
  };
  const fullMetrics = (model: string): PromptMetrics => {
    const cached = fullByModel.get(model);
    if (cached) return cached;
    const target = targetFor(model);
    const metrics = promptMetrics(args.request, target);
    fullByModel.set(model, metrics);
    return metrics;
  };

  return {
    anchorSemantics: "stored_input",
    providerBlockDepthFor: (model) => fullMetrics(model).blockDepth,
    promptEstimateFor: (model, anchor) => {
      const full = fullMetrics(model);
      if (!anchor) {
        return {
          chars: full.serializedChars,
          reusesStoredPromptTokens: false,
        };
      }

      const itemIndex = args.prefix.itemIndexByHashByModel
        .get(model)
        ?.get(anchor.hash);
      if (itemIndex === undefined) {
        return {
          chars: full.serializedChars,
          reusesStoredPromptTokens: false,
        };
      }

      const key = `${model}\u0000${itemIndex}`;
      let prefixChars = prefixCharsByModelAndItem.get(key);
      if (prefixChars === undefined) {
        prefixChars = promptMetrics(
          {
            ...args.request,
            items: args.request.items.slice(0, itemIndex + 1),
          },
          targetFor(model),
        ).serializedChars;
        prefixCharsByModelAndItem.set(key, prefixChars);
      }
      return {
        chars: Math.max(0, full.serializedChars - prefixChars),
        reusesStoredPromptTokens: true,
      };
    },
  };
}

export function promptMetrics(
  request: InteractionRequest,
  target: ProviderIdentity,
): PromptMetrics {
  const accountingInput = promptAccountingInput(request);
  const context = buildContext(accountingInput.request, target);
  const messages = context.messages.flatMap((message) => {
    const visible = providerVisibleMessage(message);
    return visible ? [visible] : [];
  });
  const tools = providerVisibleTools(request, context.tools, target);
  const prompt = {
    ...(context.systemPrompt !== undefined
      ? { systemPrompt: context.systemPrompt }
      : {}),
    ...(tools.length ? { tools } : {}),
    messages,
    ...(request.responseFormat !== undefined
      ? { responseFormat: request.responseFormat }
      : {}),
    ...(request.toolChoice !== undefined
      ? { toolChoice: request.toolChoice }
      : {}),
    ...(request.parallelToolCalls !== undefined
      ? { parallelToolCalls: request.parallelToolCalls }
      : {}),
  };
  return {
    blockDepth: messages.reduce(
      (total, message) => total + providerVisibleBlockCount(message),
      0,
    ),
    serializedChars:
      stableStringify(prompt).length + accountingInput.attachmentEstimatedChars,
  };
}

function providerVisibleMessage(
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.role !== "string") return null;
  if (value.role === "assistant") {
    return {
      role: value.role,
      content: sanitizeProviderContent(
        Array.isArray(value.content) ? value.content : [],
      ),
    };
  }
  if (value.role === "toolResult") {
    return {
      role: value.role,
      toolCallId: value.toolCallId ?? null,
      toolName: value.toolName ?? null,
      content: sanitizeProviderContent(
        Array.isArray(value.content) ? value.content : [],
      ),
      isError: value.isError === true,
    };
  }
  return {
    role: value.role,
    content: sanitizeProviderContent(value.content ?? ""),
  };
}

function sanitizeProviderContent(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((part) => {
    if (!isRecord(part)) return part;
    if (part.type === "providerItem" && isRecord(part.item)) {
      return part.item;
    }
    if (
      part.type === "image"
      && typeof part.mimeType === "string"
      && typeof part.data === "string"
    ) {
      return { ...part, data: "<image-data>" };
    }
    return part;
  });
}

function providerVisibleBlockCount(
  message: Record<string, unknown>,
): number {
  if (message.role === "toolResult") return 1;
  const content = message.content;
  return Math.max(1, Array.isArray(content) ? content.length : 1);
}

function providerVisibleTools(
  request: InteractionRequest,
  contextTools: Array<Record<string, unknown>> | undefined,
  target: ProviderIdentity,
): unknown[] {
  const definitions = toolsByWireName(request.tools);
  const tools = (contextTools ?? []).map((tool) => {
    if (typeof tool.name !== "string") return tool;
    const definition = definitions.get(tool.name);
    return definition?.kind !== "function"
      || definition.strict === undefined
      ? tool
      : { ...tool, strict: definition.strict };
  });
  if (!isOpenAIResponsesApi(target.api)) return tools;
  return [
    ...tools,
    ...request.tools.flatMap((tool) =>
      tool.kind === "hosted" ? [tool.config] : []
    ),
  ];
}

function promptAccountingInput(request: InteractionRequest): {
  request: InteractionRequest;
  attachmentEstimatedChars: number;
} {
  let attachmentEstimatedChars = 0;
  // Attachments are estimated rather than serialized: their base64 is not
  // what the provider bills, and a PDF must not reach the serializer of a
  // model that cannot carry it.
  const sanitizeContent = (parts: InteractionContent[]): InteractionContent[] =>
    parts.map((part) => {
      if (part.type === "document") {
        attachmentEstimatedChars +=
          estimatedPdfPages(part.data) * PDF_ESTIMATED_TOKENS_PER_PAGE * CHARS_PER_ESTIMATED_TOKEN;
        return { type: "text", text: "" };
      }
      if (part.type !== "image") return part;
      const detail = part.detail ?? "auto";
      attachmentEstimatedChars +=
        IMAGE_ESTIMATED_TOKENS[detail] * CHARS_PER_ESTIMATED_TOKEN;
      return { ...part, url: ACCOUNTING_IMAGE_URL };
    });
  const items = request.items.map((item) => {
    if (item.type === "message") {
      return { ...item, content: sanitizeContent(item.content) };
    }
    if (item.type === "tool_result" && Array.isArray(item.output)) {
      return { ...item, output: sanitizeContent(item.output) };
    }
    return item;
  });
  return {
    request: { ...request, items },
    attachmentEstimatedChars,
  };
}
