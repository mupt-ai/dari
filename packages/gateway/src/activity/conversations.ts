/* Conversation routes: the conversation list, one conversation's detail, and
   the retained payloads of its steps. */

import {
  conversationSummary,
  conversationTitles,
  findRecord,
  groupKeyText,
  groupsCondition,
  loadEntities,
  loadRecords,
  pyRepr,
  recordKey,
  requestBlobFormat,
  supported,
  type ConversationRecord,
  type GroupKey,
} from "./conversation_records.js";
import { criteria, readActivityQuery, readSourceScope, sourceProtocols, validatedFilters } from "./filters.js";
import type { ActivityRoute } from "./http.js";
import { notFound } from "./params.js";
import { AGENT_SESSION_KEY } from "./shared.js";
import { likePattern, raw, sql } from "./sql.js";
import { readInt, readOptionalString } from "./values.js";

export { conversation } from "./conversation_detail.js";
export { toolExchanges } from "./tool_exchanges.js";

/** What the list sorts by, as columns of a conversation's row. */
const SORTS = {
  last_active: sql`last_at`,
  messages: sql`messages_sent`,
  model_steps: sql`model_steps`,
  model_switches: sql`model_switches`,
  spend: sql`coalesce(provider_spend, 0)`,
  tokens: sql`provider_tokens`,
} as const;

export const conversations: ActivityRoute = async (request) => {
  const { params, db } = request;
  const scope = readSourceScope(params);
  const search = params.string("search", { maxLength: 200 }) ?? "";
  const sortBy = params.literal("sort_by", Object.keys(SORTS) as Array<keyof typeof SORTS>, "last_active");
  const direction = params.literal("sort_direction", ["asc", "desc"] as const, "desc");
  const limit = params.int("limit", { default: 20, ge: 1, le: 100 });
  const offset = params.int("offset", { default: 0, ge: 0 });
  const query = readActivityQuery(params);
  params.done();
  const protocols = sourceProtocols(scope);
  const organizationId = request.admitted();
  const filters = validatedFilters(query, protocols);

  const term = search.trim();
  const where = criteria(db, organizationId, filters);
  const pattern = likePattern(term);

  // One row per conversation. With a search term, `correlation_match` is
  // whether a correlation ID of any of its steps contains it.
  const correlationMatch = term === "" ? sql`0` : sql`
    max(case when lower(r.conversation_id) like ${pattern} escape '/'
               or lower(r.request_id) like ${pattern} escape '/'
               or lower(r.client_request_id) like ${pattern} escape '/'
             then 1 else 0 end)`;
  const groups = sql`
    select
      r.source_protocol,
      ${AGENT_SESSION_KEY} as conversation_key,
      r.router_id,
      r.api_key_id,
      r.attributed_user_id,
      min(r.received_at) as first_at,
      max(r.received_at) as last_at,
      count(*) filter (where r.request_kind = 'user_message') as messages_sent,
      count(*) as model_steps,
      sum(coalesce(r.provider_total_tokens, 0)) as provider_tokens,
      sum(r.provider_total_cost_usd) as provider_spend,
      count(*) filter (where r.model_switched is true) as model_switches,
      ${correlationMatch} as correlation_match
    from routing_requests r
    where ${where}
    group by r.source_protocol, ${AGENT_SESSION_KEY}, r.router_id, r.api_key_id, r.attributed_user_id`;

  // A search keeps the conversations matching on a correlation ID, the ID or
  // name of their router, key, or person, or their latest title.
  const rows = term === "" ? groups : sql`
    select g.*
    from (${groups}) g
    left join model_routers mr on mr.id = g.router_id and mr.organization_id = ${organizationId}
    left join organization_api_keys k on k.id = g.api_key_id and k.organization_id = ${organizationId}
    left join users u on u.id = g.attributed_user_id
    where g.correlation_match = 1
       or lower(g.conversation_key) like ${pattern} escape '/'
       or lower(g.router_id) like ${pattern} escape '/'
       or lower(mr.name) like ${pattern} escape '/'
       or lower(g.api_key_id) like ${pattern} escape '/'
       or lower(k.label) like ${pattern} escape '/'
       or lower(k.key_prefix) like ${pattern} escape '/'
       or lower(g.attributed_user_id) like ${pattern} escape '/'
       or lower(u.display_name) like ${pattern} escape '/'
       or lower(u.email) like ${pattern} escape '/'
       or lower((
            select r.conversation_title
            from routing_requests r
            where r.organization_id = ${organizationId}
              and r.source_protocol = g.source_protocol
              and ${AGENT_SESSION_KEY} = g.conversation_key
              and (r.router_id = g.router_id or (r.router_id is null and g.router_id is null))
              and (r.api_key_id = g.api_key_id or (r.api_key_id is null and g.api_key_id is null))
              and (r.attributed_user_id = g.attributed_user_id
                   or (r.attributed_user_id is null and g.attributed_user_id is null))
              and r.conversation_title is not null
            order by r.received_at desc, r.id desc
            limit 1
          )) like ${pattern} escape '/'`;

  // The page, with the totals over every conversation on each of its rows;
  // one row of totals alone when the page is empty.
  const order = sql`${SORTS[sortBy]} ${raw(direction)}, last_at desc, source_protocol, conversation_key`;
  const page = await db.all(sql`
    with conversation_rows as (${rows}),
    conversation_page as (
      select *
      from conversation_rows
      order by ${order}
      limit ${limit + 1} offset ${offset}
    ),
    conversation_totals as (
      select
        count(*) as conversation_count,
        coalesce(sum(model_switches), 0) as total_model_switches,
        count(*) filter (where model_switches > 0) as conversations_with_model_switches
      from conversation_rows
    )
    select
      p.source_protocol,
      p.conversation_key,
      p.router_id,
      p.api_key_id,
      p.attributed_user_id,
      p.model_switches,
      t.conversation_count,
      t.total_model_switches,
      t.conversations_with_model_switches
    from conversation_totals t
    left join conversation_page p on true
    order by ${order}`);
  const totals = page[0]!;
  const switches = new Map<string, number>();
  let keys: GroupKey[] = [];
  for (const row of page) {
    if (row.conversation_key === null || row.conversation_key === undefined) continue;
    const key: GroupKey = {
      sourceProtocol: String(row.source_protocol),
      conversationKey: String(row.conversation_key),
      routerId: readOptionalString(row.router_id),
      apiKeyId: readOptionalString(row.api_key_id),
      attributedUserId: readOptionalString(row.attributed_user_id),
    };
    keys.push(key);
    switches.set(groupKeyText(key), readInt(row.model_switches));
  }
  let nextOffset: number | null = null;
  if (keys.length > limit) {
    keys = keys.slice(0, limit);
    nextOffset = offset + limit;
  }
  const items: object[] = [];
  if (keys.length > 0) {
    const [records, titles] = await Promise.all([
      loadRecords(db, sql`${where} and ${groupsCondition(keys)}`),
      conversationTitles(db, organizationId, keys),
    ]);
    const entities = await loadEntities(db, records);
    const byGroup = new Map<string, ConversationRecord[]>();
    for (const record of records) {
      const text = groupKeyText(recordKey(record));
      byGroup.set(text, [...(byGroup.get(text) ?? []), record]);
    }
    for (const key of keys) {
      const text = groupKeyText(key);
      items.push(conversationSummary(byGroup.get(text)!, entities, titles.get(text), switches.get(text)!));
    }
  }
  return {
    conversations: items,
    conversation_count: readInt(totals.conversation_count),
    model_switches: readInt(totals.total_model_switches),
    conversations_with_model_switches: readInt(totals.conversations_with_model_switches),
    limit,
    offset,
    next_offset: nextOffset,
  };
};

const PAYLOAD_KEYS = {
  client_request: "requestBlobKey",
  client_response: "responseBlobKey",
  selector_output: "selectorOutputBlobKey",
} as const;

/** A step's stored client request, client response, or selector output. */
export const payload = (kind: keyof typeof PAYLOAD_KEYS): ActivityRoute => async (request) => {
  request.params.done();
  const organizationId = request.admitted();
  const requestId = request.path.request_id!;
  const record = await findRecord(request.db, requestId);
  if (!supported(record, organizationId)) throw notFound(`Unknown routing request ${pyRepr(requestId)}.`);
  const missing = notFound(`No ${kind.replace(/_/g, " ")} payload is stored for this routing request.`);
  const key = record[PAYLOAD_KEYS[kind]];
  if (record.blobBucket === null || key === null) throw missing;
  const body = await request.platform.readBlob(record.blobBucket, key);
  if (body === null) throw missing;
  const format = kind === "client_request" ? requestBlobFormat(record) : null;
  const headers: Record<string, string> = {
    "Content-Type": kind === "selector_output" ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
  };
  if (format !== null) headers["X-Dari-Request-Format"] = format;
  return new Response(body, { headers });
};
