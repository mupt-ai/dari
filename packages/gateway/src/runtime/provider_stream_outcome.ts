import { isRecord } from "@mupt-ai/dari-router/policy-engine";
import type { InteractionOutput } from "../interaction/types.js";
import { scrubSecrets } from "../telemetry/scrub.js";

export type ProviderStreamOutcome =
  | {
      status: "completed";
      message: Record<string, unknown>;
      output: InteractionOutput;
    }
  | {
      status: "provider_error";
      message: Record<string, unknown>;
    }
  | {
      status: "aborted";
      message: null;
      responseBody: Record<string, unknown>;
    };

export function isProviderFailureMessage(message: Record<string, unknown>): boolean {
  return message.stopReason === "error" || message.stopReason === "aborted";
}

export function providerFailureFromEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(event.error)) {
    return isProviderFailureMessage(event.error)
      ? event.error
      : providerFailure(
          stringValue(event.error.errorMessage) ?? stringValue(event.error.message) ?? "Provider request failed."
        );
  }
  return providerFailure(
    stringValue(event.error) ?? stringValue(event.errorMessage) ?? stringValue(event.message) ?? "Provider request failed."
  );
}

export function providerFailureFromCaught(error: unknown): Record<string, unknown> {
  const failure = providerFailure(caughtErrorMessage(error));
  if (!isRecord(error)) return failure;
  for (const key of ["statusCode", "status_code", "status", "httpStatus", "code", "error"]) {
    if (error[key] !== undefined) failure[key] = error[key];
  }
  return failure;
}

/**
 * A terminal provider message remains the source of truth for exact usage even
 * when translating that message into a client protocol response fails.
 */
export function providerFailureFromTerminal(
  error: unknown,
  terminalMessage: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...providerFailureFromCaught(error),
    ...(typeof terminalMessage.responseId === "string"
      ? { responseId: terminalMessage.responseId }
      : {}),
    ...(isRecord(terminalMessage.usage)
      ? { usage: terminalMessage.usage }
      : {}),
  };
}

function caughtErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Provider request failed.";
}

export function providerFailure(message: string): Record<string, unknown> {
  return { stopReason: "error", errorMessage: message, content: [] };
}

export function providerFailureMessage(message: Record<string, unknown>): string {
  const detail = stringValue(message.errorMessage);
  return detail ? scrubSecrets(detail) : "Provider request failed.";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const CREDENTIAL_REJECTED = "provider_credential_rejected";

export type CredentialRejection = { provider: string; status: number };

/** Mark a failure where the provider refused the customer's own API key. */
export function failureWithCredentialRejection(
  failure: Record<string, unknown>,
  rejection: CredentialRejection,
): Record<string, unknown> {
  return { ...failure, [CREDENTIAL_REJECTED]: rejection };
}

export function credentialRejectionFromFailure(
  failure: Record<string, unknown>,
): CredentialRejection | null {
  const marker = failure[CREDENTIAL_REJECTED];
  return typeof marker === "object" && marker !== null ? marker as CredentialRejection : null;
}
