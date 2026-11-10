import {
  decodeUntrustedPortableReasoningState as coreDecode,
  encodePortableReasoningState as coreEncode,
  type PortableReasoningState,
} from "@mupt-ai/dari-router/protocols";

import { rethrowFrameworkErrorAsHttp } from "../http/errors.js";

export type { PortableReasoningState } from "@mupt-ai/dari-router/protocols";

export function encodePortableReasoningState(state: PortableReasoningState): string {
  try {
    return coreEncode(state);
  } catch (error) {
    rethrowFrameworkErrorAsHttp(error, 500);
  }
}

export function decodeUntrustedPortableReasoningState(value: string): PortableReasoningState | null {
  try {
    return coreDecode(value);
  } catch (error) {
    rethrowFrameworkErrorAsHttp(error, 400);
  }
}
