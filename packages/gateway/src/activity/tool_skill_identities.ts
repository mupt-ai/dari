/* Who used a tool or skill: people, or the API key for unassigned traffic. */

import { IDENTITY_API_KEY, identityKey } from "./shared.js";
import { sql } from "./sql.js";
import { readInstant, readInt, readOptionalString, type Instant } from "./values.js";
import { FILE_READS, itemColumn, scopeCriteria, usesCount, type Scope } from "./tool_skill_activity.js";
export type TopIdentity = {
  id: string;
  identity_type: "person" | "api_key";
  name: string;
  detail: string;
  uses: number;
  file_reads: number;
};

export type Identity = TopIdentity & {
  latest_at: Instant;
  api_keys: Array<{ id: string; label: string; key_prefix: string; uses: number; file_reads: number }>;
};

type IdentityRow = {
  capabilityId: string | null;
  userId: string | null;
  identityApiKeyId: string | null;
  apiKeyId: string | null;
  uses: number;
  fileReads: number;
  latestAt: Instant;
};

type Records = {
  users: Map<string, { display_name: string | null; email: string }>;
  apiKeys: Map<string, { label: string; key_prefix: string }>;
};

/** Python's tuple sort: compare keys in order; strings by code point. */
function compareKeys(left: ReadonlyArray<number | string>, right: ReadonlyArray<number | string>): number {
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]!;
    const b = right[i]!;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function readIdentityRow(row: Record<string, unknown>): IdentityRow {
  return {
    capabilityId: readOptionalString(row.capability_id),
    userId: readOptionalString(row.attributed_user_id),
    identityApiKeyId: readOptionalString(row.identity_api_key_id),
    apiKeyId: readOptionalString(row.api_key_id),
    uses: readInt(row.uses),
    fileReads: readInt(row.file_reads),
    latestAt: readInstant(row.latest_at),
  };
}

/** Each item's identities, most active first. */
export async function loadItemIdentities(scope: Scope, capabilityIds: string[]): Promise<Map<string, TopIdentity[]>> {
  const grouped = new Map<string, Array<[TopIdentity, Instant]>>();
  if (capabilityIds.length === 0) return new Map();
  const item = itemColumn(scope.mode);
  const rows = (await scope.db.all(sql`
    select
      ${item} as capability_id,
      r.attributed_user_id,
      ${IDENTITY_API_KEY} as identity_api_key_id,
      ${usesCount(scope.mode)} as uses,
      ${FILE_READS} as file_reads,
      cast(max(r.received_at) as text) as latest_at
    from routing_tool_skill_events e
    join routing_requests r on r.id = e.routing_request_id
    where ${scopeCriteria(scope)}
      and ${item} in (${capabilityIds})
    group by ${item}, r.attributed_user_id, ${IDENTITY_API_KEY}`)).map(readIdentityRow);
  const records = await identityRecords(scope, rows);
  for (const row of rows) {
    if (row.capabilityId === null) throw new Error("Tool or skill identity query returned a missing capability ID.");
    const list = grouped.get(row.capabilityId) ?? [];
    list.push([summaryIdentity(row, records), row.latestAt]);
    grouped.set(row.capabilityId, list);
  }
  const result = new Map<string, TopIdentity[]>();
  for (const [capabilityId, values] of grouped) {
    const sortKey = ([identity, latest]: [TopIdentity, Instant]) =>
      [-(identity.uses + identity.file_reads), -identity.uses, -latest, identity.name.toLowerCase(), identity.id];
    values.sort((a, b) => compareKeys(sortKey(a), sortKey(b)));
    result.set(capabilityId, values.map(([identity]) => identity));
  }
  return result;
}

/** One item's identities with each one's API keys, most active first. */
export async function loadDetailIdentities(scope: Scope, capabilityId: string): Promise<Identity[]> {
  const rows = (await scope.db.all(sql`
    select
      r.attributed_user_id,
      ${IDENTITY_API_KEY} as identity_api_key_id,
      r.api_key_id,
      ${usesCount(scope.mode)} as uses,
      ${FILE_READS} as file_reads,
      cast(max(r.received_at) as text) as latest_at
    from routing_tool_skill_events e
    join routing_requests r on r.id = e.routing_request_id
    where ${scopeCriteria(scope)}
      and ${itemColumn(scope.mode)} = ${capabilityId}
    group by r.attributed_user_id, ${IDENTITY_API_KEY}, r.api_key_id`)).map(readIdentityRow);
  const records = await identityRecords(scope, rows);
  const grouped = new Map<string, IdentityRow[]>();
  for (const row of rows) {
    const key = JSON.stringify(identityKey(row.userId, row.identityApiKeyId));
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const identities: Identity[] = [];
  for (const identityRows of grouped.values()) {
    const summary = summaryIdentity(identityRows[0]!, records);
    const keyed = identityRows.filter((row) => row.apiKeyId !== null && records.apiKeys.has(row.apiKeyId));
    const keySort = (row: IdentityRow) =>
      [-(row.uses + row.fileReads), -row.uses, records.apiKeys.get(row.apiKeyId!)!.label.toLowerCase(), row.apiKeyId!];
    keyed.sort((a, b) => compareKeys(keySort(a), keySort(b)));
    identities.push({
      id: summary.id,
      identity_type: summary.identity_type,
      name: summary.name,
      detail: summary.detail,
      uses: identityRows.reduce((total, row) => total + row.uses, 0),
      file_reads: identityRows.reduce((total, row) => total + row.fileReads, 0),
      latest_at: Math.max(...identityRows.map((row) => row.latestAt)),
      api_keys: keyed.map((row) => {
        const key = records.apiKeys.get(row.apiKeyId!)!;
        return { id: row.apiKeyId!, label: key.label, key_prefix: key.key_prefix, uses: row.uses, file_reads: row.fileReads };
      }),
    });
  }
  const sortKey = (identity: Identity) =>
    [-(identity.uses + identity.file_reads), -identity.uses, -identity.latest_at, identity.name.toLowerCase(), identity.id];
  return identities.sort((a, b) => compareKeys(sortKey(a), sortKey(b)));
}

export function topIdentity(identity: Identity): TopIdentity {
  return {
    id: identity.id,
    identity_type: identity.identity_type,
    name: identity.name,
    detail: identity.detail,
    uses: identity.uses,
    file_reads: identity.file_reads,
  };
}

async function identityRecords(scope: Scope, rows: IdentityRow[]): Promise<Records> {
  const userIds = [...new Set(rows.flatMap((row) => (row.userId === null ? [] : [row.userId])))];
  const apiKeyIds = [...new Set(rows.flatMap((row) => [row.identityApiKeyId, row.apiKeyId].filter((id): id is string => id !== null)))];
  const users: Records["users"] = new Map();
  const apiKeys: Records["apiKeys"] = new Map();
  if (userIds.length > 0) {
    for (const user of await scope.db.all(sql`select id, display_name, email from users where id in (${userIds})`)) {
      users.set(String(user.id), { display_name: readOptionalString(user.display_name), email: String(user.email) });
    }
  }
  if (apiKeyIds.length > 0) {
    const keys = await scope.db.all(sql`
      select id, label, key_prefix
      from organization_api_keys
      where organization_id = ${scope.organizationId}
        and id in (${apiKeyIds})`);
    for (const key of keys) apiKeys.set(String(key.id), { label: String(key.label), key_prefix: String(key.key_prefix) });
  }
  return { users, apiKeys };
}

function summaryIdentity(row: IdentityRow, records: Records): TopIdentity {
  const counts = { uses: row.uses, file_reads: row.fileReads };
  if (row.userId !== null) {
    const user = records.users.get(row.userId);
    return {
      id: `person:${row.userId}`,
      identity_type: "person",
      name: user ? user.display_name || user.email : "Deleted User",
      detail: user ? user.email : "User No Longer Available",
      ...counts,
    };
  }
  if (row.identityApiKeyId !== null) {
    const key = records.apiKeys.get(row.identityApiKeyId);
    return {
      id: `key:${row.identityApiKeyId}`,
      identity_type: "api_key",
      name: key ? key.label : "Deleted API Key",
      detail: key ? `${key.key_prefix}… · Shared / Unassigned` : "API Key No Longer Available",
      ...counts,
    };
  }
  return { id: "unattributed", identity_type: "api_key", name: "Unattributed", detail: "No API Key Attribution", ...counts };
}
