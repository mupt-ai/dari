import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { scopedHarnessSessionId } from "../runtime/harness_identity/conversation.js";
import { ActivityStore } from "../self_host/activity_store.js";
import { handleActivityRequest, type ActivityPlatform } from "./http.js";
import { canonicalInstant } from "./values.js";

const ORG = "org_1";
const at = (seconds: number) => canonicalInstant(Date.UTC(2026, 2, 10) * 1000 + seconds * 1_000_000);
const claudeSession = (sessionId: string) => scopedHarnessSessionId({
  identity: { kind: "claude_code_session", value: sessionId },
  sourceProtocol: "anthropic_messages",
  scope: { organizationId: ORG, routerId: "rtr_1", apiKeyId: "oak_1", attributedUserId: "usr_ada" },
});

let db: Database;

/** File git events on a step's session, as its tool output showed them. */
function stepEvents(requestId: string, events: Array<Record<string, unknown>>) {
  for (const event of events) {
    db.query(`insert into routing_git_events
        (id, organization_id, routing_request_id, source_protocol, agent_session_id, occurred_at, ordinal, kind, repository, number, title, branch)
      select ?, organization_id, id, source_protocol, agent_session_id, received_at, ?, ?, ?, ?, ?, ? from routing_requests where id = ?`)
      .run(`rge_${Math.random()}`, event.ordinal as number, event.kind as string, event.repository as string,
        (event.number ?? null) as number | null, (event.title ?? null) as string | null, (event.branch ?? null) as string | null, requestId);
  }
}

/** The self-hosted store with two Claude Code sessions. */
function platform(): ActivityPlatform {
  db = new Database(":memory:");
  const store = new ActivityStore(db);
  db.exec(`
    insert into model_routers (id, organization_id, name) values ('rtr_1', '${ORG}', 'Main Router');
    insert into organization_api_keys (id, organization_id, label, key_prefix) values ('oak_1', '${ORG}', 'Laptop', 'dari_abc');
    insert into users (id, email, display_name) values ('usr_ada', 'ada@example.test', 'Ada');
    insert into routing_request_blobs (object_key, body) values ('a-1', '{"messages":["a"]}'), ('b-1', '{"messages":["b"]}');
  `);
  const insert = db.query(`insert into routing_requests (id, request_id, organization_id, source_protocol, router_id,
    api_key_id, attributed_user_id, request_kind, agent_session_id, conversation_id, conversation_title, stream, status,
    selected_model, selected_provider, provider_total_tokens, provider_total_cost_usd, provider_pricing_known,
    message_count, has_tools, received_at, created_at, blob_bucket, request_blob_key, request_blob_format)
    values (?, ?, '${ORG}', 'anthropic_messages', 'rtr_1', 'oak_1', 'usr_ada', 'user_message', ?, ?, ?, 1, 'completed',
      ?, 'anthropic', ?, ?, 1, 2, 1, ?, ?, 'gateway', ?, 'interaction_request_v1')`);
  insert.run("rreq_a1", "req-a1", claudeSession("sess-a"), "ctx-a", "Fix login", "anthropic/claude-opus", 1000, "1.25", at(0), at(0), "a-1");
  insert.run("rreq_a2", "req-a2", claudeSession("sess-a"), "ctx-a", null, "anthropic/claude-haiku", 500, "0.25", at(10), at(10), null);
  insert.run("rreq_b1", "req-b1", claudeSession("sess-b"), "ctx-b", "Fix tests", "anthropic/claude-opus", 300, "0.5", at(20), at(20), "b-1");
  return {
    db: store.reads,
    saveSessionGitEvents: (write) => store.saveSessionGitEvents(write),
    authorize: async () => ({ organizationId: ORG }),
    readBlob: async (bucket, key) => (bucket === "gateway" ? store.readBlob(key) : null),
  };
}

async function call(p: ActivityPlatform, path: string) {
  const response = (await handleActivityRequest(new Request(`http://x${path}`), p))!;
  return { status: response.status, body: await response.json() };
}

const activity = (path: string) => `/v1/organizations/${ORG}/routing/activity/${path}`;

test("sessions link to the pull requests they opened, worked on, or pushed the branch of", async () => {
  const p = platform();
  // sess-a pushes fix-login and opens #7 from it; sess-b later pushes the same branch and runs `gh pr` on #9.
  stepEvents("rreq_a1", [
    { kind: "push", repository: "acme/web", branch: "fix-login", ordinal: 3 },
    { kind: "opened", repository: "acme/web", number: 7, title: "Fix login", branch: "fix-login", ordinal: 5 },
  ]);
  stepEvents("rreq_b1", [
    { kind: "push", repository: "acme/web", branch: "fix-login", ordinal: 1 },
    { kind: "referenced", repository: "acme/web", number: 9, ordinal: 2 },
  ]);

  const list = await call(p, activity("pull-requests"));
  // Both last saw activity in sess-b's step; ties go to the higher number.
  expect(list.body.pull_requests.map((pr: { number: number }) => pr.number)).toEqual([9, 7]);
  expect(list.body.pull_requests[1]).toMatchObject({
    repository: "acme/web",
    url: "https://github.com/acme/web/pull/7",
    title: "Fix login",
    branch: "fix-login",
    opened_at: "2026-03-10T00:00:00Z",
    conversation_count: 2,
    model_steps: 3,
    provider_total_tokens: 1800,
    provider_spend_usd: "2.00",
    models: ["anthropic/claude-opus", "anthropic/claude-haiku"],
    people: [{ user_id: "usr_ada", name: "Ada" }],
  });
  expect((await call(p, activity("pull-requests?search=LOGIN"))).body.pull_requests.map((pr: { number: number }) => pr.number)).toEqual([7]);

  const detail = await call(p, activity("pull-requests/Acme/Web/7"));
  expect(detail.body.conversations.map((c: { conversation_ref: string }) => c.conversation_ref)).toEqual(["rreq_b1", "rreq_a1"]);
  expect((await call(p, activity("pull-requests/acme/web/8"))).status).toBe(404);

  const sessions = await call(p, activity("conversations?from=2026-03-09T00:00:00Z&to=2026-03-11T00:00:00Z"));
  const prsOf = (ref: string) => sessions.body.conversations.find((c: { conversation_ref: string }) => c.conversation_ref === ref)
    .pull_requests.map((pr: { number: number }) => pr.number);
  expect(prsOf("rreq_a1")).toEqual([7]);
  expect(prsOf("rreq_b1")).toEqual([9, 7]);
  expect((await call(p, activity("conversations/rreq_b1"))).body.conversation.pull_requests[0]).toEqual({
    repository: "acme/web", number: 9, url: "https://github.com/acme/web/pull/9", title: null,
  });
});

test("a reused branch's later pushes go to the pull request opened on it last", async () => {
  const p = platform();
  stepEvents("rreq_a1", [{ kind: "opened", repository: "acme/web", number: 7, branch: "fix", ordinal: 1 }]);
  stepEvents("rreq_a2", [{ kind: "opened", repository: "acme/web", number: 12, branch: "fix", ordinal: 1 }]);
  stepEvents("rreq_b1", [{ kind: "push", repository: "acme/web", branch: "fix", ordinal: 1 }]);
  const detail = await call(p, activity("pull-requests/acme/web/12"));
  expect(detail.body.conversations.map((c: { conversation_ref: string }) => c.conversation_ref)).toEqual(["rreq_b1", "rreq_a1"]);
  expect((await call(p, activity("pull-requests/acme/web/7"))).body.pull_request.conversation_count).toBe(1);
});

test("a session's reported commit links it to the pull request on its branch", async () => {
  const p = platform();
  stepEvents("rreq_a1", [{ kind: "opened", repository: "acme/web", number: 7, branch: "fix", ordinal: 1 }]);
  const sha = "f".repeat(40);
  await p.saveSessionGitEvents({
    organizationId: ORG,
    sourceProtocol: "anthropic_messages",
    agentSessionId: claudeSession("sess-b"),
    events: [{ kind: "commit", repository: "acme/web", branch: "fix", commit_sha: sha, number: null, title: null, ordinal: 0 }],
  });
  const detail = await call(p, activity("conversations/rreq_b1"));
  expect(detail.body.conversation.pull_requests.map((pr: { number: number }) => pr.number)).toEqual([7]);
  expect(detail.body.commits).toEqual([expect.objectContaining({ repository: "acme/web", sha, branch: "fix" })]);
  expect((await call(p, activity("pull-requests/acme/web/7"))).body.pull_request.conversation_count).toBe(2);
});

test("a pull request opened without naming its branch is on the branch its session pushed", async () => {
  const p = platform();
  stepEvents("rreq_a1", [
    { kind: "push", repository: "acme/web", branch: "fix", ordinal: 1 },
    { kind: "opened", repository: "acme/web", number: 7, ordinal: 2 },
  ]);
  stepEvents("rreq_b1", [{ kind: "push", repository: "acme/web", branch: "fix", ordinal: 1 }]);
  const sessions = await call(p, activity("conversations?from=2026-03-09T00:00:00Z&to=2026-03-11T00:00:00Z"));
  const b = sessions.body.conversations.find((c: { conversation_ref: string }) => c.conversation_ref === "rreq_b1");
  expect(b.pull_requests.map((pr: { number: number }) => pr.number)).toEqual([7]);
  expect((await call(p, activity("pull-requests/acme/web/7"))).body.pull_request).toMatchObject({ branch: "fix", conversation_count: 2 });
});
