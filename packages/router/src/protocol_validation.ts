import { RouterFrameworkError } from "./framework_error.js";
import type {
  RouterContent,
  RouterSelection,
  RouterTool,
  RouterToolChoice,
} from "./framework_types.js";
import { isRecord } from "./types.js";

export function invalidProtocolRequest(
  message: string,
  param?: string,
): RouterFrameworkError {
  return new RouterFrameworkError(
    "invalid_request",
    message,
    "invalid_request",
    param,
  );
}

export function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix?: string,
): void {
  const field = Object.keys(value).find((name) => !allowed.includes(name));
  if (field === undefined) return;
  const param = prefix ? `${prefix}.${field}` : field;
  throw new RouterFrameworkError(
    "invalid_request",
    `${param} is not supported by the portable router contract.`,
    "unsupported_field",
    param,
  );
}

export function validateToolChoice(
  choice: RouterToolChoice | undefined,
  tools: readonly RouterTool[],
): void {
  if (choice === undefined || choice === "none" || choice === "auto") return;
  if (tools.length === 0) {
    throw invalidProtocolRequest("tool_choice requires at least one tool.", "tool_choice");
  }
  if (typeof choice !== "string" && !tools.some((tool) => tool.name === choice.name)) {
    throw invalidProtocolRequest(
      `tool_choice references unknown tool '${choice.name}'.`,
      "tool_choice",
    );
  }
}

// `dari_routing` response metadata, matching the managed Dari platform's wire shape.
export function dariRoutingPayload<Metadata>(
  requestedModel: string,
  selection: RouterSelection<Metadata>,
): Record<string, unknown> {
  return {
    requested_model: requestedModel,
    selected_model: selection.decision.selectedModel,
    reasoning_effort: selection.decision.reasoningEffort,
    reason: selection.decision.reason,
  };
}

export function requiredString(value: unknown, param: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidProtocolRequest(`${param} must be a non-empty string.`, param);
  }
  return value;
}

export function optionalString(value: unknown, param: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw invalidProtocolRequest(`${param} must be a string.`, param);
  }
  return value;
}

// Empty and whitespace-only cache keys mean "no cache key": preserving them
// would make every such request share one lease bucket.
export function optionalCacheKey(value: unknown, param: string): string | undefined {
  const cacheKey = optionalString(value, param);
  return cacheKey !== undefined && cacheKey.trim() ? cacheKey : undefined;
}

export function optionalNumberInRange(
  value: unknown,
  param: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidProtocolRequest(
      `${param} must be between ${minimum} and ${maximum}.`,
      param,
    );
  }
  return value;
}

export function positiveInteger(value: unknown, param: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidProtocolRequest(`${param} must be a positive integer.`, param);
  }
  return value;
}

export function optionalPositiveInteger(
  value: unknown,
  param: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return positiveInteger(value, param);
}

export function optionalBoolean(value: unknown, param: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw invalidProtocolRequest(`${param} must be a boolean.`, param);
  }
  return value;
}

export function optionalRecord(
  value: unknown,
  param: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw invalidProtocolRequest(`${param} must be an object.`, param);
  }
  return value;
}

export function stopSequenceValues(
  value: unknown,
  param: string,
  allowBareString: boolean,
): string | string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && allowBareString) return value;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalidProtocolRequest(
      allowBareString
        ? `${param} must be a string or array of strings.`
        : `${param} must be an array of strings.`,
      param,
    );
  }
  return value;
}

export function isAllEmptyText(parts: readonly RouterContent[]): boolean {
  return parts.every((part) => part.type === "text" && part.text.length === 0);
}

export function prefixedWireId(value: string, prefix: string): string {
  return (value.startsWith(prefix) ? value : `${prefix}${value.replace(/[^A-Za-z0-9_-]/g, "_")}`)
    .slice(0, 64);
}

export function portableTool(
  fields: Record<string, unknown>,
  options: {
    names: Set<string>;
    param: string;
    schemaField: string;
    schemaRequired: boolean;
  },
): RouterTool {
  const name = requiredString(fields.name, `${options.param}.name`);
  if (options.names.has(name)) {
    throw invalidProtocolRequest(`Duplicate tool '${name}'.`, `${options.param}.name`);
  }
  options.names.add(name);
  const schemaParam = `${options.param}.${options.schemaField}`;
  const schema = fields[options.schemaField];
  if (schema === undefined) {
    if (options.schemaRequired) {
      throw invalidProtocolRequest(`${schemaParam} must be an object.`, schemaParam);
    }
  } else if (!isRecord(schema)) {
    throw invalidProtocolRequest(`${schemaParam} must be an object.`, schemaParam);
  }
  const description = optionalString(fields.description, `${options.param}.description`);
  const strict = optionalBoolean(fields.strict, `${options.param}.strict`);
  return {
    name,
    ...(description === undefined ? {} : { description }),
    inputSchema: schema ?? { type: "object" },
    ...(strict === undefined ? {} : { strict }),
  };
}
