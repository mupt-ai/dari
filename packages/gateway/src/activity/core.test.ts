import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { divideFormat, filterOptions, models, overview, routers, series } from "./core.js";
import type { ActivityPlatform, ActivityRoute } from "./http.js";
import { Params } from "./params.js";
import { sqliteActivityDb } from "./sql.js";
import { parseDecimal } from "./values.js";

const database = new Database(":memory:");
database.run(`create table users (id text primary key, email text not null, display_name text)`);
database.run(`create table model_routers (id text primary key, name text not null)`);
database.run(`create table organization_api_keys (
  id text primary key, organization_id text not null, label text not null, key_prefix text not null,
  created_for_user_id text, attributed_to_user_id text)`);
database.run(`create table routing_requests (
  id text primary key, organization_id text not null, router_id text, api_key_id text, attributed_user_id text,
  received_at text not null, source_protocol text not null, request_kind text, conversation_id text, status text,
  selected_model text, selected_provider text, provider_key_source text, decision_details text,
  provider_input_tokens integer, provider_cache_read_tokens integer, provider_cache_write_tokens integer,
  provider_output_tokens integer, provider_total_tokens integer, provider_total_cost_usd numeric,
  provider_pricing_known integer, provider_latency_ms integer, prefix_warm_tokens integer,
  benchmark_model_id text, benchmark_replay_cost_usd numeric, model_switched integer)`);
database.run(`insert into users values ('usr_ada', 'ada@example.com', 'Ada')`);
database.run(`insert into model_routers values ('rtr', 'Main')`);
database.run(`insert into organization_api_keys values ('key_a', 'org', 'Laptop', 'dari_a', 'usr_ada', null)`);
const insert = database.prepare(`insert into routing_requests
  (id, organization_id, router_id, api_key_id, attributed_user_id, received_at, source_protocol, request_kind,
   conversation_id, status, selected_model, selected_provider, provider_key_source, decision_details,
   provider_input_tokens, provider_total_tokens, provider_total_cost_usd, provider_pricing_known, provider_latency_ms,
   prefix_warm_tokens, benchmark_model_id, benchmark_replay_cost_usd, model_switched)
  values (?, 'org', 'rtr', 'key_a', 'usr_ada', ?, 'openai_chat', ?, 'c1', ?, ?, ?, 'managed', ?, 10, 12, ?, ?, ?, ?, 'big', ?, 0)`);
insert.run("r1", "2026-03-02T01:00:00.000000Z", "user_message", "completed", "small", "openai", null, "0.5", 1, 100, 0, "2");
insert.run("r2", "2026-03-02T02:00:00.123456Z", "tool_continuation", "completed", "big", "openai", '{"selected_reasoning_effort":"high"}', "0.25", 1, 300, 5, "0.25");
insert.run("r3", "2026-03-03T01:00:00.000000Z", "user_message", "provider_error", null, null, null, null, 0, null, 0, null);

const platform = {} as ActivityPlatform;
async function call(route: ActivityRoute, query = ""): Promise<any> {
  const params = new Params(new URLSearchParams(`from=2026-03-02T00:00:00Z&to=2026-03-04T00:00:00Z&${query}`));
  return route({ db: sqliteActivityDb(database), platform, params, path: {}, admitted: () => "org" });
}

test("overview sums usage, savings, and keys on SQLite", async () => {
  const body = await call(overview, "bucket_seconds=86400");
  expect(body.summary).toMatchObject({
    messages_sent: 2, model_steps: 3, provider_total_tokens: 36, provider_spend_usd: "0.75",
    priced_model_steps: 2, predicted_warm_requests: 1, savings_vs_most_expensive_usd: "1.5",
  });
  expect(body.series.map((point: any) => [point.bucket_start, point.model, point.thinking_level])).toEqual([
    ["2026-03-02T00:00:00Z", "big", "high"],
    ["2026-03-02T00:00:00Z", "small", null],
    ["2026-03-03T00:00:00Z", "selector-unresolved", null],
  ]);
  expect(body.api_keys[0]).toMatchObject({
    label: "Laptop", assigned_user_name: "Ada", model_steps: 3, latest_at: "2026-03-03T01:00:00Z",
  });
});

test("series and routers bucket messages on SQLite", async () => {
  const body = await call(series, "bucket_seconds=3600");
  expect(body.series[1].bucket_start).toBe("2026-03-02T02:00:00Z");
  expect(body.series[0].predicted_warm_requests).toBeUndefined();
  const router = (await call(routers, "bucket_seconds=86400")).routers[0];
  expect(router).toMatchObject({ router_id: "rtr", messages_sent: 2, completed_requests: 2, provider_error_requests: 1 });
});

test("models report switches and latency on SQLite", async () => {
  const body = await call(models);
  expect(body.summary).toMatchObject({ model_steps: 3, observed_conversations: 1, model_switches: 1, switched_conversations: 1 });
  expect(body.transitions[0]).toMatchObject({ from_model: "small", to_model: "big", to_thinking_level: "high", tool_continuations: 1, switch_share: 1 });
  // The benchmark model's own step saves only what switching back onto it cost.
  expect(body.models.find((model: any) => model.model === "big").savings_vs_most_expensive_usd).toBe("0");
  expect(body.models.find((model: any) => model.model === "small").provider_latency_p95_ms).toBe(100);
});

test("filter options list what the range saw", async () => {
  const body = await call(filterOptions);
  expect(body.routers).toEqual([{ id: "rtr", name: "Main" }]);
  expect(body.api_keys[0]).toMatchObject({ id: "key_a", assigned_user_name: "Ada" });
  expect(body.models.map((model: any) => model.id)).toEqual(["big", "selector-unresolved", "small"]);
  expect(body.providers).toEqual(["openai"]);
});

test("cost per step divides as Python's Decimal", () => {
  expect(divideFormat(parseDecimal("14.4858819101"), 14)).toBe("1.034705850721428571428571429");
  expect(divideFormat(parseDecimal("0.0000000000"), 3)).toBe("0.0000000000");
  expect(divideFormat(parseDecimal("1.50"), 3)).toBe("0.50");
});
