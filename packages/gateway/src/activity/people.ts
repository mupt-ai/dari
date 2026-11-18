/* People & Keys: Activity per person, and per API key for traffic no person
   is attributed to (`people-keys`), and people over time (`people-series`). */

import {
  bucketIndex,
  bucketStart,
  criteria,
  MODEL,
  readActivityQuery,
  readSourceScope,
  sourceProtocols,
  validatedBucketFilters,
  validatedFilters,
  type ActivityFilters,
} from "./filters.js";
import type { ActivityRoute } from "./http.js";
import { badRequest } from "./params.js";
import { and, likePattern, or, raw, sql, type ActivityDb, type Sql } from "./sql.js";
import {
  AGENT_SESSION_KEY,
  IDENTITY_API_KEY,
  THINKING_LEVEL,
  thinkingLevelValue,
  type ReasoningEffort,
} from "./shared.js";
import {
  decimalText,
  formatInstant,
  readInstant,
  readInt,
  readOptionalInstant,
  readOptionalString,
  type Instant,
} from "./values.js";
const PEOPLE_KEYS_DEFAULT_LIMIT = 20;
const PEOPLE_KEYS_MAX_LIMIT = 100;
const PEOPLE_COMPARISON_MAX_USERS = 10;
const DEFAULT_COMPARISON_USERS = 3;

const IDENTITY_SCOPES = ["all", "people", "keys"] as const;
const IDENTITY_SORTS = ["identity", "keys", "conversations", "messages", "tokens", "spend", "last_active"] as const;
const SORT_DIRECTIONS = ["asc", "desc"] as const;

type Row = Record<string, unknown>;

export const peopleKeys: ActivityRoute = async (request) => {
  const { params, db } = request;
  const search = params.string("search", { maxLength: 200 }) ?? "";
  const scope = params.literal("identity_scope", IDENTITY_SCOPES, "all");
  const sortBy = params.literal("sort_by", IDENTITY_SORTS, "last_active");
  const direction = params.literal("sort_direction", SORT_DIRECTIONS, "desc");
  const limit = params.int("limit", { default: PEOPLE_KEYS_DEFAULT_LIMIT, ge: 1, le: PEOPLE_KEYS_MAX_LIMIT });
  const offset = params.int("offset", { default: 0, ge: 0 });
  const sourceScope = readSourceScope(params);
  const query = readActivityQuery(params);
  params.done();
  const protocols = sourceProtocols(sourceScope);
  const organizationId = request.admitted();
  const filters = validatedFilters(query, protocols);

  const { identities, identityCount } = await loadIdentityPage(db, organizationId, filters, {
    search: search.trim(),
    scope,
    sortBy,
    direction,
    limit,
    offset,
  });
  const nextOffset = offset + identities.length;
  return {
    from_at: formatInstant(filters.start),
    to_at: formatInstant(filters.end),
    identities,
    identity_count: identityCount,
    limit,
    offset,
    next_offset: nextOffset < identityCount ? nextOffset : null,
  };
};

export const peopleSeries: ActivityRoute = async (request) => {
  const { params, db } = request;
  const bucketSeconds = params.int("bucket_seconds", { ge: 60 });
  const requested = params.strings("comparison_user_id");
  const sourceScope = readSourceScope(params);
  const query = readActivityQuery(params);
  params.done();
  const protocols = sourceProtocols(sourceScope);
  const organizationId = request.admitted();
  const filters = validatedBucketFilters(query, protocols, bucketSeconds);
  const userIds = validatedComparisonUserIds(requested);
  const where = criteria(db, organizationId, filters);
  const bucket = bucketIndex(db, filters);

  const activeRows = await db.all<Row>(sql`
    select
      ${bucket} as bucket_index,
      count(distinct r.attributed_user_id) as active_people
    from routing_requests r
    where ${where}
      and r.attributed_user_id is not null
    group by 1
    order by 1`);

  if (userIds.length === 0) {
    const busiest = await db.all<Row>(sql`
      select r.attributed_user_id
      from routing_requests r
      where ${where}
        and r.attributed_user_id is not null
      group by r.attributed_user_id
      order by count(*) desc, r.attributed_user_id
      limit ${DEFAULT_COMPARISON_USERS}`);
    userIds.push(...busiest.map((row) => String(row.attributed_user_id)));
  }

  const users = await loadComparisonUsers(db, userIds);
  const compared = users.map((user) => user.id);
  const peopleSeries: object[] = [];
  if (compared.length > 0) {
    const points = await db.all<Row>(sql`
      select
        ${bucket} as bucket_index,
        r.attributed_user_id,
        count(*) filter (where r.request_kind = 'user_message') as messages_sent,
        count(*) as model_steps,
        coalesce(sum(r.provider_total_tokens), 0) as total_tokens,
        cast(sum(r.provider_total_cost_usd) as text) as provider_spend
      from routing_requests r
      where ${where}
        and r.attributed_user_id in (${compared})
      group by 1, 2
      order by 1, 2`);
    const counts = await db.all<Row>(sql`
      select
        d.bucket_index,
        d.attributed_user_id,
        count(*) as conversations
      from (
        select distinct
          ${bucket} as bucket_index,
          r.attributed_user_id,
          r.router_id,
          r.api_key_id,
          r.source_protocol,
          ${AGENT_SESSION_KEY} as conversation_marker
        from routing_requests r
        where ${where}
          and r.attributed_user_id in (${compared})
      ) d
      group by d.bucket_index, d.attributed_user_id`);
    const conversations = new Map(
      counts.map((row) => [`${readInt(row.bucket_index)}\0${row.attributed_user_id}`, readInt(row.conversations)]),
    );
    for (const row of points) {
      peopleSeries.push({
        bucket_start: bucketStart(filters, row.bucket_index),
        user_id: String(row.attributed_user_id),
        messages_sent: readInt(row.messages_sent),
        model_steps: readInt(row.model_steps),
        conversations: conversations.get(`${readInt(row.bucket_index)}\0${row.attributed_user_id}`) ?? 0,
        provider_total_tokens: readInt(row.total_tokens),
        provider_spend_usd: decimalText(row.provider_spend),
      });
    }
  }

  return {
    from_at: formatInstant(filters.start),
    to_at: formatInstant(filters.end),
    bucket_seconds: filters.bucketSeconds,
    active_people_series: activeRows.map((row) => ({
      bucket_start: bucketStart(filters, row.bucket_index),
      active_people: readInt(row.active_people),
    })),
    comparison_users: users,
    people_series: peopleSeries,
  };
};

function validatedComparisonUserIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length > PEOPLE_COMPARISON_MAX_USERS) {
    throw badRequest(`Select at most ${PEOPLE_COMPARISON_MAX_USERS} people to compare.`);
  }
  if (unique.some((id) => id === "" || [...id].length > 200)) {
    throw badRequest("Comparison user IDs must contain 1 to 200 characters.");
  }
  return unique;
}

/** The requested people who exist, in the requested order. */
async function loadComparisonUsers(db: ActivityDb, userIds: readonly string[]) {
  if (userIds.length === 0) return [];
  const ids = [...new Set(userIds)].slice(0, PEOPLE_COMPARISON_MAX_USERS);
  const rows = await db.all<Row>(sql`select id, display_name, email from users where id in (${ids})`);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids.flatMap((id) => {
    const user = byId.get(id);
    if (user === undefined) return [];
    const email = String(user.email);
    return [{ id, name: (user.display_name as string | null) || email, email }];
  });
}

/* The identity page. */

type PageQuery = {
  search: string;
  scope: (typeof IDENTITY_SCOPES)[number];
  sortBy: (typeof IDENTITY_SORTS)[number];
  direction: "asc" | "desc";
  limit: number;
  offset: number;
};

type ModelMix = { model: string; thinking_level: ReasoningEffort | null; provider: string | null; model_steps: number };

const IDENTITY_NAME = sql`coalesce(u.display_name, u.email, k.label, 'Unattributed')`;

const SORTS: Record<PageQuery["sortBy"], Sql> = {
  identity: sql`lower(${IDENTITY_NAME})`,
  keys: sql`s.api_key_count`,
  conversations: sql`coalesce(c.conversations, 0)`,
  messages: sql`s.messages_sent`,
  tokens: sql`s.total_tokens`,
  spend: sql`coalesce(s.provider_spend, 0)`,
  last_active: sql`s.latest_at`,
};

/** The in-memory key of an identity: a person, an unassigned key, or neither. */
function identityKey(userId: string | null, apiKeyId: string | null): string {
  if (userId !== null) return `person\0${userId}`;
  if (apiKeyId !== null) return `api_key\0${apiKeyId}`;
  return "api_key";
}

async function loadIdentityPage(db: ActivityDb, organizationId: string, filters: ActivityFilters, query: PageQuery) {
  const where = criteria(db, organizationId, filters);
  const conditions: Sql[] = [];
  if (query.scope === "people") conditions.push(sql`s.attributed_user_id is not null`);
  if (query.scope === "keys") conditions.push(sql`s.attributed_user_id is null`);
  if (query.search) conditions.push(searchCriterion(where, organizationId, query.search));

  // `s`: each identity's totals. `c`: each identity's conversations.
  const statement = sql`
    with s as (
      select
        r.attributed_user_id,
        ${IDENTITY_API_KEY} as identity_api_key_id,
        count(*) filter (where r.request_kind = 'user_message') as messages_sent,
        count(*) as model_steps,
        count(distinct r.api_key_id) as api_key_count,
        coalesce(sum(r.provider_total_tokens), 0) as total_tokens,
        coalesce(sum(r.provider_cache_read_tokens), 0) as cache_read_tokens,
        sum(r.provider_total_cost_usd) as provider_spend,
        max(r.received_at) as latest_at
      from routing_requests r
      where ${where}
      group by r.attributed_user_id, ${IDENTITY_API_KEY}
    ),
    c as (
      select
        d.attributed_user_id,
        d.identity_api_key_id,
        count(*) as conversations
      from (
        select distinct
          r.attributed_user_id,
          ${IDENTITY_API_KEY} as identity_api_key_id,
          r.router_id,
          r.api_key_id,
          r.source_protocol,
          ${AGENT_SESSION_KEY} as conversation_marker
        from routing_requests r
        where ${where}
      ) d
      group by d.attributed_user_id, d.identity_api_key_id
    )
    select
      s.attributed_user_id,
      s.identity_api_key_id,
      s.messages_sent,
      s.model_steps,
      s.total_tokens,
      s.cache_read_tokens,
      cast(s.provider_spend as text) as provider_spend,
      cast(s.latest_at as text) as latest_at,
      coalesce(c.conversations, 0) as conversations,
      ${IDENTITY_NAME} as identity_name,
      u.email as user_email
    from s
    left join users u on u.id = s.attributed_user_id
    left join organization_api_keys k on k.id = s.identity_api_key_id
    left join c
      on (s.attributed_user_id = c.attributed_user_id
          or (s.attributed_user_id is null and c.attributed_user_id is null))
     and (s.identity_api_key_id = c.identity_api_key_id
          or (s.identity_api_key_id is null and c.identity_api_key_id is null))
    where ${and(conditions)}`;

  const [countRow] = await db.all<Row>(sql`select count(*) as count from (${statement}) page`);
  const identityCount = readInt(countRow?.count);
  const rows = await db.all<Row>(sql`
    ${statement}
    order by
      ${SORTS[query.sortBy]} ${raw(query.direction)},
      lower(${IDENTITY_NAME}),
      coalesce(s.attributed_user_id, s.identity_api_key_id, '')
    limit ${query.limit} offset ${query.offset}`);
  if (rows.length === 0) return { identities: [], identityCount };

  const page = rows.map((row) => ({
    row,
    userId: readOptionalString(row.attributed_user_id),
    apiKeyId: readOptionalString(row.identity_api_key_id),
  }));
  const pageWhere = sql`${where} and ${pageIdentityCriterion(page)}`;
  const mix = await identityModelMix(db, pageWhere);
  const usage = await identityKeyUsage(db, pageWhere);
  const keys = await loadApiKeys(db, organizationId, new Set([...usage.values()].flatMap((used) => [...used.keys()])));

  const identities = page.map(({ row, userId, apiKeyId }) => {
    const key = identityKey(userId, apiKeyId);
    const used = usage.get(key) ?? new Map<string, number>();
    const apiKeys = [...used.keys()]
      .filter((id) => keys.has(id))
      .map((id) => ({ ...keys.get(id)!, model_steps: used.get(id)! }))
      .sort((a, b) => compareText(a.label.toLowerCase(), b.label.toLowerCase()) || compareText(a.id, b.id));
    return {
      id: userId !== null ? `person:${userId}` : apiKeyId !== null ? `key:${apiKeyId}` : "unattributed",
      identity_type: userId !== null ? "person" : "api_key",
      user_id: userId,
      api_key_id: apiKeyId,
      name: String(row.identity_name),
      email: readOptionalString(row.user_email),
      api_keys: apiKeys,
      conversations: readInt(row.conversations),
      messages_sent: readInt(row.messages_sent),
      model_steps: readInt(row.model_steps),
      provider_total_tokens: readInt(row.total_tokens),
      provider_cache_read_tokens: readInt(row.cache_read_tokens),
      provider_spend_usd: decimalText(row.provider_spend),
      latest_at: formatInstant(readInstant(row.latest_at)),
      model_mix: mix.get(key) ?? [],
    };
  });
  return { identities, identityCount };
}

/** Name, email, IDs, or any API key (ID, label, prefix) the identity used. */
function searchCriterion(where: Sql, organizationId: string, search: string): Sql {
  const pattern = likePattern(search);
  const matchingKeys = sql`
    select k2.id
    from organization_api_keys k2
    where k2.organization_id = ${organizationId}
      and (
        lower(k2.id) like ${pattern} escape '/'
        or lower(k2.label) like ${pattern} escape '/'
        or lower(k2.key_prefix) like ${pattern} escape '/'
      )`;
  return sql`
    lower(${IDENTITY_NAME}) like ${pattern} escape '/'
    or lower(u.email) like ${pattern} escape '/'
    or lower(s.attributed_user_id) like ${pattern} escape '/'
    or lower(s.identity_api_key_id) like ${pattern} escape '/'
    or s.attributed_user_id in (
      select distinct r.attributed_user_id
      from routing_requests r
      where ${where}
        and r.attributed_user_id is not null
        and r.api_key_id in (${matchingKeys})
    )
    or (s.attributed_user_id is null and s.identity_api_key_id in (${matchingKeys}))`;
}

/** The steps of the identities on the page. */
function pageIdentityCriterion(page: ReadonlyArray<{ userId: string | null; apiKeyId: string | null }>): Sql {
  const people = page.flatMap(({ userId }) => (userId === null ? [] : [userId]));
  const keys = page.flatMap(({ userId, apiKeyId }) => (userId === null && apiKeyId !== null ? [apiKeyId] : []));
  const conditions: Sql[] = [];
  if (people.length > 0) conditions.push(sql`r.attributed_user_id in (${people})`);
  if (keys.length > 0) conditions.push(sql`r.attributed_user_id is null and r.api_key_id in (${keys})`);
  if (page.some(({ userId, apiKeyId }) => userId === null && apiKeyId === null)) {
    conditions.push(sql`r.attributed_user_id is null and r.api_key_id is null`);
  }
  return or(conditions);
}

async function identityModelMix(db: ActivityDb, where: Sql): Promise<Map<string, ModelMix[]>> {
  const rows = await db.all<Row>(sql`
    select
      r.attributed_user_id,
      ${IDENTITY_API_KEY} as identity_api_key_id,
      ${MODEL} as model,
      ${THINKING_LEVEL} as thinking_level,
      r.selected_provider,
      count(*) as model_steps
    from routing_requests r
    where ${where}
    group by 1, 2, 3, 4, 5`);
  const grouped = new Map<string, ModelMix[]>();
  for (const row of rows) {
    const key = identityKey(readOptionalString(row.attributed_user_id), readOptionalString(row.identity_api_key_id));
    const mix = grouped.get(key) ?? [];
    mix.push({
      model: String(row.model),
      thinking_level: thinkingLevelValue(row.thinking_level),
      provider: readOptionalString(row.selected_provider),
      model_steps: readInt(row.model_steps),
    });
    grouped.set(key, mix);
  }
  for (const mix of grouped.values()) {
    mix.sort((a, b) =>
      b.model_steps - a.model_steps
      || compareText(a.model, b.model)
      || compareText(a.thinking_level ?? "", b.thinking_level ?? "")
      || compareText(a.provider ?? "", b.provider ?? ""));
  }
  return grouped;
}

/** Model steps per identity and the API key it used. */
async function identityKeyUsage(db: ActivityDb, where: Sql): Promise<Map<string, Map<string, number>>> {
  const rows = await db.all<Row>(sql`
    select
      r.attributed_user_id,
      ${IDENTITY_API_KEY} as identity_api_key_id,
      r.api_key_id,
      count(*) as model_steps
    from routing_requests r
    where ${where}
      and r.api_key_id is not null
    group by 1, 2, 3`);
  const usage = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = identityKey(readOptionalString(row.attributed_user_id), readOptionalString(row.identity_api_key_id));
    const used = usage.get(key) ?? new Map<string, number>();
    used.set(String(row.api_key_id), readInt(row.model_steps));
    usage.set(key, used);
  }
  return usage;
}

/** The organization's keys among `ids`, with their status now. */
async function loadApiKeys(db: ActivityDb, organizationId: string, ids: Set<string>) {
  const keys = new Map<string, { id: string; label: string; key_prefix: string; status: string }>();
  if (ids.size === 0) return keys;
  const rows = await db.all<Row>(sql`
    select id, label, key_prefix, expires_at, revoked_at
    from organization_api_keys
    where organization_id = ${organizationId}
      and id in (${[...ids]})`);
  const now: Instant = Date.now() * 1000;
  for (const row of rows) {
    const expiresAt = readOptionalInstant(row.expires_at);
    const status = row.revoked_at !== null && row.revoked_at !== undefined
      ? "revoked"
      : expiresAt !== null && expiresAt <= now ? "expired" : "active";
    const id = String(row.id);
    keys.set(id, { id, label: String(row.label), key_prefix: String(row.key_prefix), status });
  }
  return keys;
}

/** Python's string order, by code point. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
