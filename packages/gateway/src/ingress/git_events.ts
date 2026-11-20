/* `POST /v1/dari/git-events`: the Dari CLI's git hook (`dari git-hook
   post-commit`) reports a commit made in a coding agent's session. It
   authenticates with the key the session's requests used and names the
   agent's own session ID, so the session is found exactly as its requests
   are stamped (`runtime/harness_identity`). Activity links the session to
   the pull request on the commit's branch. */

import type { ActivityPlatform } from "../activity/http.js";
import { sql, type ActivityDb } from "../activity/sql.js";
import { canonicalInstant, instantFromDate } from "../activity/values.js";
import { bearerToken } from "../http/auth.js";
import { errorResponse, HttpError } from "../http/errors.js";
import { scopedHarnessSessionId } from "../runtime/harness_identity/index.js";
import { resolveRouter } from "../strategies/routing.js";
import type { CommitEvent } from "../telemetry/tools/git_events.js";

const MAX_COMMITS = 50;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// How far back a Codex subagent's thread is looked for.
const SUBAGENT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Each agent's session as its requests carry it, and the protocol it speaks.
const HARNESSES = {
  claude_code: { kind: "claude_code_session", sourceProtocol: "anthropic_messages" },
  codex: { kind: "codex_thread", sourceProtocol: "openai_responses" },
} as const;

export async function handleGitEvents(request: Request, routerId: string, activity: ActivityPlatform | undefined): Promise<Response> {
  try {
    if (activity === undefined) throw new HttpError(404, "Not found", "not_found");
    const apiKey = bearerToken(request.headers);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const harness = HARNESSES[String(body?.harness) as keyof typeof HARNESSES];
    if (harness === undefined) throw new HttpError(400, "harness must be claude_code or codex.", "invalid_request_error", "harness");
    const sessionId = typeof body?.session_id === "string" ? body.session_id.trim().toLowerCase() : "";
    if (!UUID.test(sessionId)) throw new HttpError(400, "session_id must be a UUID.", "invalid_request_error", "session_id");
    const commits = Array.isArray(body?.commits) ? body.commits : null;
    if (commits === null || commits.length === 0 || commits.length > MAX_COMMITS) {
      throw new HttpError(400, `commits must list 1 to ${MAX_COMMITS} commits.`, "invalid_request_error", "commits");
    }
    const events = commits.map(commitEvent);
    const router = await resolveRouter({ routerId, apiKey, provisional: true });
    const agentSessionId = scopedHarnessSessionId({
      identity: { kind: harness.kind, value: sessionId },
      sourceProtocol: harness.sourceProtocol,
      scope: {
        organizationId: router.organization_id,
        routerId: router.router_id,
        apiKeyId: router.api_key_id,
        attributedUserId: router.attributed_user_id,
      },
    });
    let session = agentSessionId;
    if (harness.kind === "codex_thread") {
      const found = await codexSession(activity.db, router.organization_id, agentSessionId, sessionId);
      // A subagent can commit before its first request is recorded; the hook
      // asks again, and on its last try (`final`) files it under the thread.
      if (found === null && body?.final !== true) {
        throw new HttpError(409, "No request names this Codex thread yet; report it again shortly.", "session_pending", "session_id");
      }
      session = found ?? agentSessionId;
    }
    await activity.saveSessionGitEvents({
      organizationId: router.organization_id,
      sourceProtocol: harness.sourceProtocol,
      agentSessionId: session,
      events,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}

function commitEvent(value: unknown, ordinal: number): CommitEvent {
  const commit = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const field = (name: string, max: number) => {
    const text = commit[name];
    if (text === undefined || text === null) return null;
    if (typeof text !== "string" || text.length > max) {
      throw new HttpError(400, `commits[${ordinal}].${name} must be a string of at most ${max} characters.`, "invalid_request_error", "commits");
    }
    return text;
  };
  const repository = field("repository", 200)?.toLowerCase() ?? "";
  const branch = field("branch", 255) ?? "";
  const sha = field("sha", 64)?.toLowerCase() ?? "";
  if (!REPOSITORY.test(repository) || branch === "" || !SHA.test(sha)) {
    throw new HttpError(400, `commits[${ordinal}] needs a GitHub repository (owner/name), a branch, and a full sha.`, "invalid_request_error", "commits");
  }
  const number = commit.pull_request ?? null;
  if (number !== null && !(Number.isSafeInteger(number) && (number as number) >= 1)) {
    throw new HttpError(400, `commits[${ordinal}].pull_request must be a pull request number.`, "invalid_request_error", "commits");
  }
  return {
    kind: "commit",
    repository,
    branch,
    commit_sha: sha,
    number: number as number | null,
    title: number === null ? null : field("title", 300),
    ordinal,
  };
}

/**
 * The session a Codex thread belongs to, or null while no request names it.
 * A subagent's thread is its own `CODEX_THREAD_ID`, but its requests are
 * stamped with its parent's session, so a thread no request was stamped with
 * is looked up among recent subagent requests, which name it as their agent.
 */
async function codexSession(db: ActivityDb, organizationId: string, ownSession: string, threadId: string): Promise<string | null> {
  const own = await db.all(sql`
    select 1 as found
    from routing_requests
    where organization_id = ${organizationId}
      and agent_session_id = ${ownSession}
    limit 1`);
  if (own.length > 0) return ownSession;
  const since = canonicalInstant(instantFromDate(new Date(Date.now() - SUBAGENT_LOOKBACK_MS)));
  const [parent] = await db.all(db.dialect === "postgres"
    ? sql`
      select agent_session_id
      from routing_requests
      where organization_id = ${organizationId}
        and source_protocol = 'openai_responses'
        and received_at >= ${since}::timestamptz
        and agent_session_id is not null
        and request_metadata -> 'agent_context' ->> 'agentId' = ${threadId}
      order by received_at desc
      limit 1`
    : sql`
      select agent_session_id
      from routing_requests
      where organization_id = ${organizationId}
        and source_protocol = 'openai_responses'
        and received_at >= ${since}
        and agent_session_id is not null
        and json_extract(request_metadata, '$.agent_context.agentId') = ${threadId}
      order by received_at desc
      limit 1`);
  return parent === undefined ? null : String(parent.agent_session_id);
}
