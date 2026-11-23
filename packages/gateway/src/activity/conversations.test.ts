import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { handleActivityRequest, type ActivityPlatform } from "./http.js";
import { sqliteActivityDb } from "./sql.js";
import { canonicalInstant } from "./values.js";

const ORG = "org_1";
const at = (seconds: number) => canonicalInstant(Date.UTC(2026, 2, 10) * 1000 + seconds * 1_000_000 + 250);

function platform(routerZdr = 0): ActivityPlatform {
  const db = new Database(":memory:");
  db.exec(`
    create table routing_requests (
      id text primary key, request_id text, client_request_id text, organization_id text, source_protocol text,
      router_id text, api_key_id text, attributed_user_id text, request_kind text, conversation_id text,
      agent_session_id text, conversation_title text, zdr integer, status text, error_code text, error_message text,
      selected_model text, selected_provider text, provider_input_tokens integer, provider_cache_read_tokens integer,
      provider_cache_write_tokens integer, provider_output_tokens integer, provider_total_tokens integer,
      provider_total_cost_usd numeric, provider_pricing_known integer, provider_key_source text,
      selector_latency_ms integer, provider_latency_ms integer, total_latency_ms integer, message_count integer,
      has_tools integer, model_switched integer, received_at text, completed_at text, decision_details text,
      request_metadata text, selector_reason text, blob_bucket text, request_blob_key text, response_blob_key text,
      selector_output_blob_key text, request_blob_format text);
    create table model_routers (id text, organization_id text, name text, zdr integer);
    create table organization_api_keys (id text, organization_id text, label text, key_prefix text);
    create table users (id text, display_name text, email text);
    create table routing_tool_skill_events (id text, routing_request_id text, ordinal integer, event_type text,
      capability_id text, observed_name text, skill_version text, evidence_source text, exchange_context_hash text, tool_call_id text);
    create table routing_tool_result_observations (id text, routing_request_id text, exchange_context_hash text, tool_call_id text);
    insert into model_routers values ('rtr_1', '${ORG}', 'Main Router', ${routerZdr});
    insert into organization_api_keys values ('oak_1', '${ORG}', 'Laptop', 'dari_abc');
  `);
  const insert = db.query(`insert into routing_requests (id, request_id, organization_id, source_protocol, router_id,
    api_key_id, request_kind, conversation_id, zdr, status, selected_model, selected_provider, provider_total_tokens,
    provider_total_cost_usd, provider_pricing_known, message_count, has_tools, model_switched, received_at, completed_at,
    decision_details, blob_bucket, request_blob_key, request_blob_format)
    values (?, ?, '${ORG}', 'openai_chat', 'rtr_1', 'oak_1', ?, 'conv-a', 0, 'completed', ?, 'openai', 100, ?, 1, 2, 1, ?, ?, ?, ?, 'bucket', ?, ?)`);
  insert.run("rreq_1", "req-1", "user_message", "openai/gpt-a", "0.0100000000", 0, at(0), at(2),
    JSON.stringify({ selected_reasoning_effort: "high", selector_lease_turns: 3 }), "key-1", "chat_projection_v1");
  insert.run("rreq_2", "req-2", "tool_result", "openai/gpt-b", "0.0250000000", 1, at(10), at(12),
    JSON.stringify({ selector_lease_turns: 3.5 }), null, null);
  db.exec(`
    insert into routing_tool_skill_events values ('ev_1', 'rreq_1', 0, 'tool_call', 'tool:read', 'Read', null, 'declared', 'ctx', 'call-1');
    insert into routing_tool_result_observations values ('obs_1', 'rreq_2', 'ctx', 'call-1');
  `);
  return {
    db: sqliteActivityDb(db),
    saveSessionGitEvents: async () => {},
    authorize: async () => ({ organizationId: ORG }),
    readBlob: async (bucket, key) => (bucket === "bucket" && key === "key-1" ? '{"messages":[]}' : null),
  };
}

async function get(p: ActivityPlatform, path: string) {
  const response = (await handleActivityRequest(new Request(`http://x/v1/organizations/${ORG}/routing/activity/${path}`), p))!;
  return { status: response.status, headers: response.headers, body: await response.text() };
}

const RANGE = "from=2026-03-09T00:00:00Z&to=2026-03-11T00:00:00Z";

test("lists a conversation with its exact spend and switches", async () => {
  const response = await get(platform(), `conversations?${RANGE}`);
  expect(response.status).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.conversation_count).toBe(1);
  expect(body.model_switches).toBe(1);
  expect(body.conversations[0]).toMatchObject({
    conversation_ref: "rreq_1",
    router_name: "Main Router",
    api_key_label: "Laptop",
    model_steps: 2,
    messages_sent: 1,
    model_path: ["openai/gpt-a", "openai/gpt-b"],
    provider_total_tokens: 200,
    // SQLite numeric affinity stores REAL, so the scale is not kept.
    provider_spend_usd: "0.035",
    first_at: "2026-03-10T00:00:00.000250Z",
  });
});

test("details a conversation's steps and matched tool exchange", async () => {
  const body = JSON.parse((await get(platform(), "conversations/req-2")).body);
  expect(body.steps.map((step: { id: string }) => step.id)).toEqual(["rreq_1", "rreq_2"]);
  expect(body.steps[0]).toMatchObject({
    selected_reasoning_effort: "high",
    selector_lease_turns: 3,
    client_request_url: `/v1/organizations/${ORG}/routing/activity/requests/rreq_1/client-request`,
    client_request_format: "chat_projection_v1",
  });
  expect(body.steps[1].selector_lease_turns).toBeNull();
  expect(body.tool_exchanges).toEqual([expect.objectContaining({
    state: "matched",
    call_event_id: "ev_1",
    result_observation_id: "obs_1",
    result_turnaround_ms: 8000,
  })]);
});

test("serves a stored payload and 404s a missing one", async () => {
  const p = platform();
  const stored = await get(p, "requests/rreq_1/client-request");
  expect(stored.status).toBe(200);
  expect(stored.body).toBe('{"messages":[]}');
  expect(stored.headers.get("X-Dari-Request-Format")).toBe("chat_projection_v1");
  expect(stored.headers.get("Cache-Control")).toBe("no-store");
  const missing = await get(p, "requests/rreq_2/client-request");
  expect(missing.status).toBe(404);
  expect(JSON.parse(missing.body).detail).toBe("No client request payload is stored for this routing request.");
});

test("summarizes a ZDR session without a content title or payload links", async () => {
  const p = platform(1);
  const list = JSON.parse((await get(p, `conversations?${RANGE}`)).body);
  expect(list.conversations[0]).toMatchObject({ title: "Zero Data Retention Session", retention: "zdr" });
  const detail = JSON.parse((await get(p, "conversations/rreq_1?limit=10")).body);
  expect(detail.conversation.title).toBe("Zero Data Retention Session");
  for (const step of detail.steps) {
    expect(step).toMatchObject({ zdr: true, client_request_url: null, client_response_url: null, selector_output_url: null });
  }
});
