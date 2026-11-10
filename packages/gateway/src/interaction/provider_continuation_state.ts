import {
  decodeUntrustedProviderContinuationState as coreDecode,
  encodeProviderContinuationState as coreEncode,
  providerIdentityFromModel as coreProviderIdentityFromModel,
  type ProviderContinuationState,
  type ProviderIdentity,
} from "@mupt-ai/dari-router/protocols";

import { rethrowFrameworkErrorAsHttp } from "../http/errors.js";

export type { ProviderContinuationState, ProviderIdentity } from "@mupt-ai/dari-router/protocols";
export { compatibleProviderContinuation, isAnthropicEffort, sameProviderIdentity } from "@mupt-ai/dari-router/protocols";

export function encodeProviderContinuationState(value: ProviderContinuationState): string {
  try {
    return coreEncode(value);
  } catch (error) {
    rethrowFrameworkErrorAsHttp(error, 500);
  }
}

export function decodeUntrustedProviderContinuationState(value: string): ProviderContinuationState | null {
  try {
    return coreDecode(value);
  } catch (error) {
    rethrowFrameworkErrorAsHttp(error, 400);
  }
}

export function providerIdentityFromModel(model: Record<string, unknown>): ProviderIdentity {
  try {
    return coreProviderIdentityFromModel(model);
  } catch (error) {
    rethrowFrameworkErrorAsHttp(error, 502);
  }
}
