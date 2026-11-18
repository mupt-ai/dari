import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import type { ActivityFilters } from "./filters.js";
import { sqliteActivityDb } from "./sql.js";
import { toolSkillActivity, toolSkillDetail, toolSkillInventory } from "./tool_skill_activity.js";
import { canonicalInstant } from "./values.js";

const DAY = 86_400_000_000;
const START = Date.parse("2026-03-02T00:00:00Z") * 1000;

function fixture() {
  const database = new Database(":memory:");
  database.run(`create table routing_requests (id text primary key, organization_id text, received_at text,
    source_protocol text, router_id text, api_key_id text, attributed_user_id text, selected_model text,
    selected_provider text, status text, provider_key_source text)`);
  database.run(`create table routing_tool_skill_events (id text primary key, routing_request_id text, event_type text,
    capability_id text, observed_name text, skill_version text, evidence_source text)`);
  database.run("create table users (id text primary key, display_name text, email text)");
  database.run("create table organization_api_keys (id text primary key, organization_id text, label text, key_prefix text)");
  database.run("insert into users values ('u1', 'Ada', 'ada@example.com')");
  database.run("insert into organization_api_keys values ('k1', 'org', 'Batch', 'dari_abc')");
  const requests: Array<[string, number, string | null]> = [
    ["r1", START + 1_000_000, "u1"],
    ["r2", START + DAY + 5, null],
    ["r3", START + DAY * 2, null],
  ];
  for (const [id, at, user] of requests) {
    database.run("insert into routing_requests values (?, 'org', ?, 'openai_chat', null, 'k1', ?, 'm', 'p', 'completed', 'user')", [id, canonicalInstant(at), user]);
  }
  const events: Array<[string, string, string, string, string, string | null, string]> = [
    ["e1", "r1", "tool_call", "tool:read", "Read", null, "model_tool_call"],
    ["e2", "r2", "tool_call", "tool:read", "Read", null, "model_tool_call"],
    ["e3", "r2", "tool_call", "tool:bash", "Bash", null, "model_tool_call"],
    ["e4", "r3", "skill_use", "skill:pdf", "pdf", "v1", "skill_tool_activation"],
    ["e5", "r3", "skill_load", "pdf/SKILL.md", "pdf", "v1", "skill_file_read"],
  ];
  for (const event of events) database.run("insert into routing_tool_skill_events values (?, ?, ?, ?, ?, ?, ?)", event);
  return sqliteActivityDb(database);
}

const filters: ActivityFilters = {
  start: START,
  end: START + DAY * 3,
  bucketSeconds: 86_400,
  protocols: ["openai_chat"],
  apiKeyIds: [],
  userIds: [],
  models: [],
};

test("tool activity counts, ranks, and buckets tool calls", async () => {
  const activity = await toolSkillActivity({ db: fixture(), organizationId: "org", filters, mode: "tools" }, "uses", []);
  expect(activity.total_uses).toBe(3);
  expect(activity.items.map((item) => [item.capability_id, item.uses, item.identity_count])).toEqual([
    ["tool:read", 2, 2],
    ["tool:bash", 1, 1],
  ]);
  expect(activity.items[0]!.top_identity?.id).toBe("key:k1");
  expect(activity.aggregate_series).toEqual([
    { bucket_start: "2026-03-02T00:00:00Z", uses: 1, file_reads: 0 },
    { bucket_start: "2026-03-03T00:00:00Z", uses: 2, file_reads: 0 },
  ]);
});

test("skill detail groups by name and splits uses from file reads", async () => {
  const detail = await toolSkillDetail({ db: fixture(), organizationId: "org", filters, mode: "skills" }, "pdf");
  expect(detail?.item).toMatchObject({ uses: 1, file_reads: 1, identity_count: 1 });
  expect(detail?.identities[0]).toMatchObject({ name: "Batch", detail: "dari_abc… · Shared / Unassigned", api_keys: [{ id: "k1", uses: 1, file_reads: 1 }] });
  expect(detail?.origins.map((origin) => origin.capability_id)).toEqual(["pdf/SKILL.md", "skill:pdf"]);
  expect(detail?.versions).toEqual([{ version: "v1", uses: 1, file_reads: 1, latest_at: "2026-03-04T00:00:00Z" }]);
});

test("inventory searches literally and pages", async () => {
  const scope = { db: fixture(), organizationId: "org", filters, mode: "tools" as const };
  const page = await toolSkillInventory(scope, { search: "", sortBy: "name", sortDirection: "asc", limit: 1, offset: 0 });
  expect(page).toMatchObject({ total_items: 2, next_offset: 1, items: [{ capability_id: "tool:bash" }] });
  const search = await toolSkillInventory(scope, { search: "READ", sortBy: "uses", sortDirection: "desc", limit: 20, offset: 0 });
  expect(search.items.map((item) => item.capability_id)).toEqual(["tool:read"]);
  const none = await toolSkillInventory(scope, { search: "%", sortBy: "uses", sortDirection: "desc", limit: 20, offset: 0 });
  expect(none.total_items).toBe(0);
});
