import type { InteractionRequest } from "../../interaction/types.js";

export const RETAINED_INTERACTION_REQUEST_FORMAT = "interaction_request_v1" as const;

type RetainedInteractionRequest = {
  format: typeof RETAINED_INTERACTION_REQUEST_FORMAT;
  json: string;
};

// This is a normalized InteractionRequest snapshot, not the original wire
// body. Compatible fields may be added in v1; semantic or structural changes
// require a new persisted format and a matching reader.
export function encodeRetainedInteractionRequest(
  request: InteractionRequest,
): RetainedInteractionRequest {
  return {
    format: RETAINED_INTERACTION_REQUEST_FORMAT,
    json: JSON.stringify(request),
  };
}
