import { isReasoningEffort, isRecord, type ChatCompletionRequest } from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../../http/errors.js";
import { parseDataImageUrl } from "../../interaction/image.js";
import { CANONICAL_ROUTER_MODEL, explicitModelId, unsupportedModelMessage } from "./router_model.js";
import {
  isProtocolToolCallId,
  TOOL_CALL_ID_MAX_LENGTH,
} from "../../interaction/tool_identity.js";
import { parsePdfDataUrl } from "../../interaction/document.js";

export function validateChatCompletionsRequest(request: ChatCompletionRequest): void {
  if (request.model !== CANONICAL_ROUTER_MODEL && explicitModelId(request.model) === null) {
    throw new HttpError(400, unsupportedModelMessage(), "unsupported_model", "model");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new HttpError(400, "messages must include at least one message.", "invalid_request_error", "messages");
  }
  validateMessages(request.messages);
  validateRequestOptions(request);
  const responsesBridge = request.source_protocol === "openai_responses";
  validateTools(request.tools, responsesBridge);
  validateToolChoice(request.tool_choice, responsesBridge);
  validateResponseFormat(request.response_format);
  validateReasoning(request);
}

function validateMessages(messages: unknown[]): void {
  const pendingToolCallIds = new Set<string>();
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) {
      throw new HttpError(400, `messages[${messageIndex}] must be an object.`, "invalid_request_error", `messages.${messageIndex}`);
    }
    if (typeof message.role !== "string" || !["system", "developer", "user", "assistant", "tool"].includes(message.role)) {
      throw new HttpError(400, `Unsupported message role at messages[${messageIndex}].role.`, "invalid_request_error", `messages.${messageIndex}.role`);
    }
    validateMessageContent(message.content, messageIndex, message.role);
    validateMessageToolCalls(message.tool_calls, messageIndex, message.role);
    validateMessageReasoning(message, messageIndex);
    if (message.role === "tool") {
      if (!isProtocolToolCallId(message.tool_call_id)) {
        throw new HttpError(400, `messages[${messageIndex}].tool_call_id is required for tool messages and must not exceed ${TOOL_CALL_ID_MAX_LENGTH} characters.`, "invalid_request_error", `messages.${messageIndex}.tool_call_id`);
      }
      if (!pendingToolCallIds.delete(message.tool_call_id)) {
        throw new HttpError(400, `messages[${messageIndex}].tool_call_id does not match any tool_call.id in the preceding assistant tool-call exchange.`, "invalid_request_error", `messages.${messageIndex}.tool_call_id`);
      }
    } else {
      pendingToolCallIds.clear();
      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          if (isRecord(toolCall) && isProtocolToolCallId(toolCall.id)) {
            pendingToolCallIds.add(toolCall.id);
          }
        }
      }
    }
    if (message.role !== "tool" && message.tool_call_id !== undefined) {
      throw new HttpError(400, `messages[${messageIndex}].tool_call_id is only supported for tool messages.`, "invalid_request_error", `messages.${messageIndex}.tool_call_id`);
    }
  });
}

function validateMessageReasoning(message: Record<string, unknown>, messageIndex: number): void {
  const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
  for (const field of reasoningFields) {
    if (message[field] === undefined) continue;
    if (message.role !== "assistant" || typeof message[field] !== "string") {
      throw new HttpError(
        400,
        `messages[${messageIndex}].${field} is only supported as a string on assistant messages.`,
        "invalid_request_error",
        `messages.${messageIndex}.${field}`
      );
    }
  }
  if (message.reasoning_details === undefined) return;
  if (message.role !== "assistant" || !Array.isArray(message.reasoning_details)) {
    throw new HttpError(
      400,
      `messages[${messageIndex}].reasoning_details must be an array on an assistant message.`,
      "invalid_request_error",
      `messages.${messageIndex}.reasoning_details`
    );
  }
  for (const [detailIndex, detail] of message.reasoning_details.entries()) {
    if (
      !isRecord(detail) ||
      detail.type !== "reasoning.encrypted" ||
      typeof detail.id !== "string" ||
      !detail.id ||
      typeof detail.data !== "string" ||
      !detail.data
    ) {
      throw new HttpError(
        400,
        `messages[${messageIndex}].reasoning_details[${detailIndex}] is not a supported encrypted reasoning detail.`,
        "invalid_request_error",
        `messages.${messageIndex}.reasoning_details.${detailIndex}`
      );
    }
  }
}

function validateMessageContent(content: unknown, messageIndex: number, role: string): void {
  if (content === undefined || content === null || typeof content === "string") return;
  if (!Array.isArray(content)) {
    throw new HttpError(400, `messages[${messageIndex}].content must be a string, an array, or null.`, "invalid_request_error", `messages.${messageIndex}.content`);
  }
  content.forEach((part, partIndex) => {
    if (!isRecord(part)) {
      throw new HttpError(400, `Unsupported content part at messages[${messageIndex}].content[${partIndex}].`, "invalid_request_error", `messages.${messageIndex}.content.${partIndex}`);
    }
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw new HttpError(400, `messages[${messageIndex}].content[${partIndex}].text must be a string.`, "invalid_request_error", `messages.${messageIndex}.content.${partIndex}.text`);
      }
      return;
    }
    if (part.type === "tool_reference") {
      if (role !== "tool") {
        throw new HttpError(400, `messages[${messageIndex}].content[${partIndex}] tool_reference blocks are only supported on tool messages.`, "invalid_request_error", `messages.${messageIndex}.content.${partIndex}.type`);
      }
      if (typeof part.tool_name !== "string" || !part.tool_name) {
        throw new HttpError(400, `messages[${messageIndex}].content[${partIndex}].tool_name must be a non-empty string.`, "invalid_request_error", `messages.${messageIndex}.content.${partIndex}.tool_name`);
      }
      return;
    }
    if (part.type === "file") {
      const fileData = isRecord(part.file) ? part.file.file_data : undefined;
      if (typeof fileData !== "string" || parsePdfDataUrl(fileData) === undefined) {
        throw new HttpError(400, `Unsupported file at messages[${messageIndex}].content[${partIndex}]; use a base64 PDF data URL in file.file_data.`, "unsupported_file_source", `messages.${messageIndex}.content.${partIndex}.file`);
      }
      return;
    }
    if (part.type === "image_url") {
      const imageUrl = part.image_url;
      const url = isRecord(imageUrl) && typeof imageUrl.url === "string" ? imageUrl.url : "";
      const detail = isRecord(imageUrl) ? imageUrl.detail : undefined;
      if (
        detail !== undefined &&
        detail !== null &&
        detail !== "auto" &&
        detail !== "low" &&
        detail !== "high" &&
        detail !== "original"
      ) {
        throw new HttpError(400, `messages[${messageIndex}].content[${partIndex}].image_url.detail is not supported.`, "invalid_request_error", `messages.${messageIndex}.content.${partIndex}.image_url.detail`);
      }
      if (!parseDataImageUrl(url)) {
        throw new HttpError(400, `Unsupported image_url at messages[${messageIndex}].content[${partIndex}]; use a base64 data URL.`, "invalid_request_error", `messages.${messageIndex}.content.${partIndex}.image_url`);
      }
      return;
    }
    throw new HttpError(400, `Unsupported content part at messages[${messageIndex}].content[${partIndex}].`, "invalid_request_error", `messages.${messageIndex}.content.${partIndex}.type`);
  });
}

function validateMessageToolCalls(toolCalls: unknown, messageIndex: number, role: string): void {
  if (toolCalls === undefined) return;
  if (role !== "assistant") {
    throw new HttpError(400, `messages[${messageIndex}].tool_calls is only supported for assistant messages.`, "invalid_request_error", `messages.${messageIndex}.tool_calls`);
  }
  if (!Array.isArray(toolCalls)) {
    throw new HttpError(400, `messages[${messageIndex}].tool_calls must be an array.`, "invalid_request_error", `messages.${messageIndex}.tool_calls`);
  }
  toolCalls.forEach((toolCall, toolCallIndex) => {
    if (!isRecord(toolCall)) {
      throw new HttpError(400, `messages[${messageIndex}].tool_calls[${toolCallIndex}] must be an object.`, "invalid_request_error", `messages.${messageIndex}.tool_calls.${toolCallIndex}`);
    }
    if (toolCall.type !== undefined && toolCall.type !== "function") {
      throw new HttpError(400, `Unsupported tool call type at messages[${messageIndex}].tool_calls[${toolCallIndex}].type.`, "invalid_request_error", `messages.${messageIndex}.tool_calls.${toolCallIndex}.type`);
    }
    if (!isProtocolToolCallId(toolCall.id)) {
      throw new HttpError(400, `messages[${messageIndex}].tool_calls[${toolCallIndex}].id must be a non-empty string no longer than ${TOOL_CALL_ID_MAX_LENGTH} characters.`, "invalid_request_error", `messages.${messageIndex}.tool_calls.${toolCallIndex}.id`);
    }
    const fn = toolCall.function;
    if (!isRecord(fn) || typeof fn.name !== "string" || fn.name.trim() === "") {
      throw new HttpError(400, `messages[${messageIndex}].tool_calls[${toolCallIndex}].function.name must be a non-empty string.`, "invalid_request_error", `messages.${messageIndex}.tool_calls.${toolCallIndex}.function.name`);
    }
    if (fn.arguments !== undefined && typeof fn.arguments !== "string" && !isRecord(fn.arguments)) {
      throw new HttpError(400, `messages[${messageIndex}].tool_calls[${toolCallIndex}].function.arguments must be a JSON string or object.`, "invalid_request_error", `messages.${messageIndex}.tool_calls.${toolCallIndex}.function.arguments`);
    }
  });
}

function validateRequestOptions(request: ChatCompletionRequest): void {
  if (request.stream !== undefined && typeof request.stream !== "boolean") {
    throw new HttpError(400, "stream must be a boolean.", "invalid_request_error", "stream");
  }
  if (request.prompt_cache_key !== undefined && typeof request.prompt_cache_key !== "string") {
    throw new HttpError(400, "prompt_cache_key must be a string.", "invalid_request_error", "prompt_cache_key");
  }
  if (request.parallel_tool_calls !== undefined && typeof request.parallel_tool_calls !== "boolean") {
    throw new HttpError(400, "parallel_tool_calls must be a boolean.", "invalid_request_error", "parallel_tool_calls");
  }
  validateNumberOption(request.temperature, "temperature");
  validateNumberOption(request.top_p, "top_p");
  validateNumberOption(request.max_tokens, "max_tokens");
  validateNumberOption(request.max_completion_tokens, "max_completion_tokens");
  if (request.stop !== undefined && typeof request.stop !== "string" && (!Array.isArray(request.stop) || request.stop.some((item) => typeof item !== "string"))) {
    throw new HttpError(400, "stop must be a string or an array of strings.", "invalid_request_error", "stop");
  }
  if (request.metadata !== undefined && !isRecord(request.metadata)) {
    throw new HttpError(400, "metadata must be an object.", "invalid_request_error", "metadata");
  }
  if (request.user !== undefined && typeof request.user !== "string") {
    throw new HttpError(400, "user must be a string.", "invalid_request_error", "user");
  }
  const raw = request as Record<string, unknown>;
  if (raw.n !== undefined && raw.n !== 1) {
    throw new HttpError(400, "Only n=1 is supported.", "invalid_request_error", "n");
  }
}

function validateReasoning(request: ChatCompletionRequest): void {
  const raw = request as Record<string, unknown>;
  if (raw.reasoning !== undefined) {
    throw new HttpError(
      400,
      "reasoning is not supported; use reasoning_effort.",
      "invalid_request_error",
      "reasoning"
    );
  }
  const effort: unknown = request.reasoning_effort;
  if (effort !== undefined && effort !== "none" && !isReasoningEffort(effort)) {
    throw new HttpError(
      400,
      "reasoning_effort is not supported.",
      "unsupported_reasoning_effort",
      "reasoning_effort"
    );
  }
}

function validateNumberOption(value: unknown, param: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new HttpError(400, `${param} must be a number.`, "invalid_request_error", param);
  }
}

function validateTools(tools: unknown, allowResponsesHostedTools: boolean): void {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) {
    throw new HttpError(400, "tools must be an array.", "invalid_request_error", "tools");
  }
  tools.forEach((tool, index) => {
    if (
      allowResponsesHostedTools &&
      isRecord(tool) &&
      (tool.type === "web_search" || tool.type === "web_search_preview")
    ) return;
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) {
      throw new HttpError(400, `tools[${index}] must be an OpenAI function tool.`, "invalid_request_error", `tools.${index}`);
    }
    const fn = tool.function;
    if (typeof fn.name !== "string" || fn.name.trim() === "") {
      throw new HttpError(400, `tools[${index}].function.name must be a non-empty string.`, "invalid_request_error", `tools.${index}.function.name`);
    }
    if (fn.description !== undefined && typeof fn.description !== "string") {
      throw new HttpError(400, `tools[${index}].function.description must be a string.`, "invalid_request_error", `tools.${index}.function.description`);
    }
    if (fn.parameters !== undefined && !isRecord(fn.parameters)) {
      throw new HttpError(400, `tools[${index}].function.parameters must be a JSON schema object.`, "invalid_request_error", `tools.${index}.function.parameters`);
    }
    if (fn.strict !== undefined && typeof fn.strict !== "boolean") {
      throw new HttpError(400, `tools[${index}].function.strict must be a boolean.`, "invalid_request_error", `tools.${index}.function.strict`);
    }
  });
}

function validateToolChoice(toolChoice: unknown, allowResponsesHostedTools: boolean): void {
  if (toolChoice === undefined) return;
  if (typeof toolChoice === "string") {
    if (["auto", "none", "required", "any"].includes(toolChoice)) return;
    throw new HttpError(400, "tool_choice must be 'auto', 'none', 'required', 'any', or a function choice object.", "invalid_request_error", "tool_choice");
  }
  if (isRecord(toolChoice) && toolChoice.type === "function" && isRecord(toolChoice.function) && typeof toolChoice.function.name === "string" && toolChoice.function.name.trim() !== "") {
    return;
  }
  if (
    allowResponsesHostedTools &&
    isRecord(toolChoice) &&
    (toolChoice.type === "web_search" || toolChoice.type === "web_search_preview")
  ) return;
  throw new HttpError(400, "tool_choice must be 'auto', 'none', 'required', 'any', or a function choice object.", "invalid_request_error", "tool_choice");
}

function validateResponseFormat(format: unknown): void {
  if (format === undefined) return;
  if (!isRecord(format) || typeof format.type !== "string") {
    throw new HttpError(400, "response_format must be an object with a supported type.", "invalid_request_error", "response_format");
  }
  if (format.type === "text" || format.type === "json_object") return;
  if (format.type !== "json_schema") {
    throw new HttpError(400, "response_format.type is not supported.", "invalid_request_error", "response_format.type");
  }
  const jsonSchema = format.json_schema;
  if (!isRecord(jsonSchema) || typeof jsonSchema.name !== "string" || jsonSchema.name.trim() === "" || !isRecord(jsonSchema.schema)) {
    throw new HttpError(400, "response_format.json_schema must include name and schema.", "invalid_request_error", "response_format.json_schema");
  }
}
