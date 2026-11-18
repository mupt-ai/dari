/* SQL expressions and value rules every Activity read shares. */

import { sql } from "./sql.js";

export const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/* Expressions over a `routing_requests` row under the alias `r`. */

/** The thinking level of the model and thinking pair that served the step. */
export const THINKING_LEVEL = sql`(r.decision_details ->> 'selected_reasoning_effort')`;

/** The persisted conversation ID, with blank IDs as missing. */
export const CONVERSATION_ID = sql`nullif(r.conversation_id, '')`;

/** The step's conversation: harness context runs grouped under their stable agent session. */
export const AGENT_SESSION_KEY = sql`coalesce(nullif(r.agent_session_id, ''), nullif(r.conversation_id, ''), r.id)`;

/** Unassigned traffic is attributed to its API key; a person's to the person. */
export const IDENTITY_API_KEY = sql`case when r.attributed_user_id is null then r.api_key_id else null end`;

/** A persisted thinking level; null for an unknown one. */
export function thinkingLevelValue(value: unknown): ReasoningEffort | null {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : null;
}

export type IdentityKey = readonly ["person" | "api_key", string | null];

/** The in-memory key of an attributed Activity identity. */
export function identityKey(attributedUserId: string | null, identityApiKeyId: string | null): IdentityKey {
  if (attributedUserId !== null) return ["person", attributedUserId];
  if (identityApiKeyId !== null) return ["api_key", identityApiKeyId];
  return ["api_key", null];
}
