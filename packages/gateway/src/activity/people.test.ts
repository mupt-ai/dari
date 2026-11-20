import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ActivityPlatform, ActivityRoute } from "./http.js";
import { Params } from "./params.js";
import { peopleKeys, peopleSeries } from "./people.js";
import { sqliteActivityDb } from "./sql.js";

const database = new Database(":memory:");
database.run(`create table users (id text primary key, email text not null, display_name text)`);
database.run(`create table organization_api_keys (
  id text primary key, organization_id text not null, label text not null, key_prefix text not null,
  expires_at text, revoked_at text)`);
database.run(`create table routing_requests (
  id text primary key, organization_id text not null, router_id text, api_key_id text, attributed_user_id text,
  received_at text not null, source_protocol text not null, request_kind text, conversation_id text,
  agent_session_id text, selected_model text, selected_provider text, provider_key_source text, status text,
  decision_details text, provider_total_tokens integer, provider_cache_read_tokens integer,
  provider_total_cost_usd numeric, provider_pricing_known integer)`);
database.run(`insert into users values ('usr_ada', 'ada@example.com', 'Ada'), ('usr_bob', 'bob@example.com', null)`);
database.run(`insert into organization_api_keys values
  ('key_a', 'org', 'Laptop', 'dari_a', null, null),
  ('key_b', 'org', 'CI', 'dari_b', null, '2026-01-01T00:00:00.000000Z')`);
const insert = database.prepare(`insert into routing_requests
  (id, organization_id, router_id, api_key_id, attributed_user_id, received_at, source_protocol, request_kind,
   conversation_id, selected_model, selected_provider, decision_details, provider_total_tokens,
   provider_cache_read_tokens, provider_total_cost_usd)
  values (?, 'org', 'rtr', ?, ?, ?, 'openai_chat', ?, ?, ?, 'openai', ?, ?, 5, ?)`);
insert.run("r1", "key_a", "usr_ada", "2026-03-02T01:00:00.000000Z", "user_message", "c1", "gpt", '{"selected_reasoning_effort":"high"}', 100, "0.5");
insert.run("r2", "key_a", "usr_ada", "2026-03-02T02:00:00.250000Z", "tool_result", "c1", "gpt", null, 50, "0.25");
insert.run("r3", "key_a", "usr_bob", "2026-03-03T01:00:00.000000Z", "user_message", "c2", null, null, 10, null);
insert.run("r4", "key_b", null, "2026-03-03T02:00:00.000000Z", "user_message", "c3", "gpt", null, 7, "1");
// Before the range every read asks for.
insert.run("r5", "key_b", null, "2026-02-01T00:00:00.000000Z", "user_message", "c4", "gpt", null, 9, "2");

const platform = {} as ActivityPlatform;
async function call(route: ActivityRoute, query: string): Promise<any> {
  const params = new Params(new URLSearchParams(`from=2026-03-02T00:00:00Z&to=2026-03-04T00:00:00Z&${query}`));
  return route({ db: sqliteActivityDb(database), platform, params, path: {}, body: async () => null, admitted: () => "org" });
}

test("people-keys aggregates people and unassigned keys on SQLite", async () => {
  const body = await call(peopleKeys, "sort_by=messages&sort_direction=desc");
  expect(body.identity_count).toBe(3);
  expect(body.identities.map((identity: any) => identity.id)).toEqual(["person:usr_ada", "person:usr_bob", "key:key_b"]);
  const ada = body.identities[0];
  expect(ada).toMatchObject({
    name: "Ada", conversations: 1, messages_sent: 1, model_steps: 2, provider_total_tokens: 150,
    provider_cache_read_tokens: 10, latest_at: "2026-03-02T02:00:00.250000Z",
    api_keys: [{ id: "key_a", label: "Laptop", key_prefix: "dari_a", status: "active", model_steps: 2 }],
  });
  expect(ada.model_mix).toEqual([
    { model: "gpt", thinking_level: null, provider: "openai", model_steps: 1 },
    { model: "gpt", thinking_level: "high", provider: "openai", model_steps: 1 },
  ]);
  expect(body.identities[2]).toMatchObject({
    name: "CI", identity_type: "api_key", model_steps: 1, api_keys: [{ status: "revoked", model_steps: 1 }],
  });
  expect(body.identities[1].model_mix[0].model).toBe("selector-unresolved");
});

test("people-keys searches by key label and pages", async () => {
  const body = await call(peopleKeys, "search=lapt&limit=1");
  expect(body.identity_count).toBe(2);
  expect(body.identities).toHaveLength(1);
  expect(body.next_offset).toBe(1);
});

test("people-series buckets the busiest people on SQLite", async () => {
  const body = await call(peopleSeries, "bucket_seconds=86400");
  expect(body.active_people_series).toEqual([
    { bucket_start: "2026-03-02T00:00:00Z", active_people: 1 },
    { bucket_start: "2026-03-03T00:00:00Z", active_people: 1 },
  ]);
  expect(body.comparison_users).toEqual([
    { id: "usr_ada", name: "Ada", email: "ada@example.com" },
    { id: "usr_bob", name: "bob@example.com", email: "bob@example.com" },
  ]);
  expect(body.people_series[0]).toMatchObject({
    bucket_start: "2026-03-02T00:00:00Z", user_id: "usr_ada", messages_sent: 1, model_steps: 2, conversations: 1,
    provider_total_tokens: 150,
  });
  expect(body.people_series[1].provider_spend_usd).toBeNull();
});
