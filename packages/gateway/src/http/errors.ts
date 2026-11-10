import { RouterFrameworkError } from "@mupt-ai/dari-router";
import { RouterCoreError } from "@mupt-ai/dari-router/policy-engine";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param?: string;
  // Response headers the error carries to the client, such as retry-after.
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    message: string,
    code = "invalid_request_error",
    param?: string,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
    this.headers = headers;
  }
}

export function errorResponseHeaders(error: unknown): Record<string, string> {
  return error instanceof HttpError && error.headers ? error.headers : {};
}

// @mupt-ai/dari-router is transport-agnostic; its error kinds map onto the HTTP
// statuses this service always used for the same conditions.
const CORE_ERROR_STATUS: Record<RouterCoreError["kind"], number> = {
  invalid_request: 400,
  selector_output: 502,
  configuration: 500,
};

export function httpErrorFrom(error: RouterCoreError): HttpError {
  return new HttpError(CORE_ERROR_STATUS[error.kind], error.message, error.code, error.param);
}

export function rethrowFrameworkErrorAsHttp(error: unknown, status: number): never {
  throw error instanceof RouterFrameworkError
    ? new HttpError(status, error.message, error.code, error.param)
    : error;
}

// Error code for logging/telemetry, covering both transport and core errors.
export function errorCode(error: unknown, fallback: string): string {
  if (
    error instanceof HttpError
    || error instanceof RouterCoreError
    || error instanceof RouterFrameworkError
  ) {
    return error.code;
  }
  return fallback;
}

export function errorResponse(error: unknown): Response {
  const normalized = normalizeError(error);
  return Response.json(
    {
      error: {
        message: normalized.message,
        type: openAiErrorType(normalized.status),
        code: normalized.code,
        ...(normalized.param ? { param: normalized.param } : {}),
      },
    },
    { status: normalized.status, headers: errorResponseHeaders(error) }
  );
}

function openAiErrorType(status: number): string {
  if (status === 429) return "rate_limit_error";
  return status >= 500 ? "server_error" : "invalid_request_error";
}

export function normalizeError(error: unknown): {
  status: number;
  message: string;
  code: string;
  param?: string;
} {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      message: error.message,
      code: error.code,
      param: error.param,
    };
  }
  if (error instanceof RouterCoreError) {
    return {
      status: CORE_ERROR_STATUS[error.kind],
      message: error.message,
      code: error.code,
      param: error.param,
    };
  }
  if (error instanceof RouterFrameworkError) {
    return {
      status: error.status,
      message: error.message,
      code: error.code,
      param: error.param,
    };
  }
  if (error instanceof Error) {
    return { status: 500, message: error.message, code: "internal_error" };
  }
  return { status: 500, message: "Internal server error", code: "internal_error" };
}
