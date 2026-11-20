/* Pull requests and the agent sessions that worked on them, read from each
   session's git events: those the gateway read from its tool output
   (`telemetry/tools/git_events.ts`) and the commits the Dari CLI's git hook
   reported (`ingress/git_events.ts`). A session is linked to the pull
   requests it opened or ran `gh pr` commands on, to the one its commit's hook
   found open on the branch, and to those whose branch it pushed or committed
   to. A push or commit goes to the latest pull request opened on its branch
   before it, or else the first one opened after it. A pull request opened
   without naming its branch is on the branch its session last pushed. */

import {
  conversationSummary,
  conversationTitles,
  fixedDecimal,
  groupKeyText,
  loadEntities,
  loadRecords,
  recordKey,
  type ConversationRecord,
} from "./conversation_records.js";
import type { ActivityRequest, ActivityRoute } from "./http.js";
import { notFound } from "./params.js";
import { sql, type ActivityDb } from "./sql.js";
import { addDecimals, formatInstant, parseDecimal, readInstant, readInt, readOptionalString, type Decimal, type Instant } from "./values.js";

// Session IDs per query: well inside every database's bound-value limit.
const SESSION_BATCH = 500;

/** An agent session: its protocol and stamped session digest. */
type SessionKey = string;
const sessionKey = (sourceProtocol: string, agentSessionId: string): SessionKey => `${sourceProtocol} ${agentSessionId}`;

type GitEvent = {
  id: string;
  session: SessionKey;
  kind: "opened" | "referenced" | "push" | "commit";
  repository: string;
  number: number | null;
  title: string | null;
  branch: string | null;
  commitSha: string | null;
  at: Instant;
  ordinal: number;
};

export type PullRequestRef = { repository: string; number: number; url: string; title: string | null };

type PullRequest = PullRequestRef & {
  branch: string | null;
  openedAt: Instant;
  /** Its first event's place in time order: a backfilled run's events share one time. */
  openedSeq: number;
  lastEventAt: Instant;
  sessions: Set<SessionKey>;
};

const prKey = (repository: string, number: number) => `${repository}#${number}`;

async function loadGitEvents(db: ActivityDb, organizationId: string, where: ReturnType<typeof sql>): Promise<GitEvent[]> {
  const rows = await db.all(sql`
    select e.id, e.kind, e.repository, e.number, e.title, e.branch, e.commit_sha, e.source_protocol, e.agent_session_id,
      e.ordinal, cast(e.occurred_at as text) as occurred_at
    from routing_git_events e
    where e.organization_id = ${organizationId} ${where}`);
  return rows.map((row) => ({
    id: String(row.id),
    session: sessionKey(String(row.source_protocol), String(row.agent_session_id)),
    kind: String(row.kind) as GitEvent["kind"],
    repository: String(row.repository),
    number: row.number === null || row.number === undefined ? null : readInt(row.number),
    title: readOptionalString(row.title),
    branch: readOptionalString(row.branch),
    commitSha: readOptionalString(row.commit_sha),
    at: readInstant(row.occurred_at),
    ordinal: readInt(row.ordinal),
  }));
}

/** Whether an event names its branch's pull request only through the branch. */
const onBranch = (event: GitEvent) => event.kind === "push" || (event.kind === "commit" && event.number === null);

const unique = <T>(values: Iterable<T | null>): T[] => [...new Set([...values].filter((value): value is T => value !== null))];

/**
 * The page's sessions' events, plus the others that decide which pull
 * requests they link to: every event on their branches or naming their pull
 * requests, then the other events of the pull requests and pushers found.
 */
async function relatedGitEvents(db: ActivityDb, organizationId: string, agentSessionIds: readonly string[]): Promise<GitEvent[]> {
  const own = await loadGitEvents(db, organizationId, sql`and e.agent_session_id in (${agentSessionIds})`);
  const repositories = unique(own.map((event) => event.repository));
  if (repositories.length === 0) return [];
  const numbers = unique(own.map((event) => event.number));
  const near = await loadGitEvents(db, organizationId, sql`and e.repository in (${repositories})
    and (e.branch in (${unique(own.map((event) => event.branch))}) or e.number in (${numbers}))`);
  const pushers = unique(near.filter((event) => event.kind === "push").map((event) => event.session.split(" ")[1]!));
  const far = await loadGitEvents(db, organizationId, sql`and e.repository in (${repositories})
    and (e.number in (${unique(near.map((event) => event.number)).filter((number) => !numbers.includes(number))})
      or (e.agent_session_id in (${pushers}) and (e.kind = 'push' or (e.kind = 'opened' and e.branch is null))))`);
  return [...new Map([...own, ...near, ...far].map((event) => [event.id, event])).values()];
}

/** The pull requests these events show, and the sessions linked to each. */
function buildPullRequests(unordered: readonly GitEvent[]): Map<string, PullRequest> {
  const events = [...unordered].sort((a, b) => a.at - b.at || a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const pullRequests = new Map<string, PullRequest>();
  const lastPushed = new Map<string, string>();
  events.forEach((event, seq) => {
    if (event.kind === "push" && event.branch !== null) lastPushed.set(`${event.session} ${event.repository}`, event.branch);
    if (onBranch(event) || event.number === null) return;
    const key = prKey(event.repository, event.number);
    const pr = pullRequests.get(key) ?? {
      repository: event.repository,
      number: event.number,
      url: `https://github.com/${event.repository}/pull/${event.number}`,
      title: null,
      branch: null,
      openedAt: event.at,
      openedSeq: seq,
      lastEventAt: event.at,
      sessions: new Set<SessionKey>(),
    };
    if (event.kind === "opened") {
      pr.title ??= event.title;
      // `gh pr create` without `--head` opens the branch the session pushed.
      pr.branch ??= event.branch ?? lastPushed.get(`${event.session} ${event.repository}`) ?? null;
      pr.openedAt = Math.min(pr.openedAt, event.at);
    }
    if (event.kind === "commit") {
      // The hook found it open on this branch, so it is that branch's.
      pr.title ??= event.title;
      pr.branch ??= event.branch;
    }
    pr.lastEventAt = Math.max(pr.lastEventAt, event.at);
    pr.sessions.add(event.session);
    pullRequests.set(key, pr);
  });
  const byBranch = new Map<string, PullRequest[]>();
  for (const pr of pullRequests.values()) {
    if (pr.branch === null) continue;
    const key = `${pr.repository} ${pr.branch}`;
    byBranch.set(key, [...(byBranch.get(key) ?? []), pr].sort((a, b) => a.openedSeq - b.openedSeq));
  }
  events.forEach((event, seq) => {
    if (!onBranch(event)) return;
    const candidates = byBranch.get(`${event.repository} ${event.branch}`);
    if (candidates === undefined) return;
    const pr = [...candidates].reverse().find((candidate) => candidate.openedSeq <= seq) ?? candidates[0]!;
    pr.sessions.add(event.session);
    pr.lastEventAt = Math.max(pr.lastEventAt, event.at);
  });
  return pullRequests;
}

/** The organization's pull requests and the sessions linked to each. */
async function loadPullRequests(db: ActivityDb, organizationId: string): Promise<Map<string, PullRequest>> {
  return buildPullRequests(await loadGitEvents(db, organizationId, sql``));
}

/** Each of these sessions' pull requests, latest first. */
async function sessionPullRequests(db: ActivityDb, organizationId: string, agentSessionIds: readonly string[]): Promise<Map<SessionKey, PullRequestRef[]>> {
  const bySession = new Map<SessionKey, PullRequest[]>();
  for (const pr of buildPullRequests(await relatedGitEvents(db, organizationId, agentSessionIds)).values()) {
    for (const session of pr.sessions) bySession.set(session, [...(bySession.get(session) ?? []), pr]);
  }
  return new Map([...bySession].map(([session, prs]) => [
    session,
    prs.sort((a, b) => b.openedAt - a.openedAt).map(({ repository, number, url, title }) => ({ repository, number, url, title })),
  ]));
}

/** The commits a session made that its git hook reported, oldest first. */
export async function sessionCommits(db: ActivityDb, organizationId: string, sourceProtocol: string | null, agentSessionId: string | null) {
  if (!sourceProtocol || !agentSessionId) return [];
  const events = await loadGitEvents(db, organizationId, sql`and e.source_protocol = ${sourceProtocol}
    and e.agent_session_id = ${agentSessionId} and e.kind = 'commit'`);
  return events
    .filter((event) => event.commitSha !== null)
    .sort((a, b) => a.at - b.at)
    .map((event) => ({
      repository: event.repository,
      sha: event.commitSha!,
      branch: event.branch,
      url: `https://github.com/${event.repository}/commit/${event.commitSha}`,
      reported_at: formatInstant(event.at),
    }));
}

type Summary = { source_protocol: string | null; agent_session_id: string | null };

/** The summaries, each with the pull requests its session worked on. */
export async function withPullRequests<T extends Summary>(db: ActivityDb, organizationId: string, summaries: readonly T[]) {
  const ids = unique(summaries.map((summary) => summary.agent_session_id || null));
  const linked = ids.length > 0 ? await sessionPullRequests(db, organizationId, ids) : new Map<SessionKey, PullRequestRef[]>();
  return summaries.map((summary) => ({
    ...summary,
    pull_requests: summary.agent_session_id && summary.source_protocol
      ? linked.get(sessionKey(summary.source_protocol, summary.agent_session_id)) ?? []
      : [],
  }));
}

type SessionTotals = { userId: string | null; steps: number; tokens: number; spend: Decimal | null; firstAt: number; lastAt: number; models: Map<string, number> };

/** Each session's totals over all its steps. */
async function sessionTotals(db: ActivityDb, organizationId: string, sessions: readonly SessionKey[]): Promise<Map<SessionKey, SessionTotals>> {
  const totals = new Map<SessionKey, SessionTotals>();
  const ids = [...new Set(sessions.map((session) => session.split(" ")[1]!))];
  for (let start = 0; start < ids.length; start += SESSION_BATCH) {
    const rows = await db.all(sql`
      select r.source_protocol, r.agent_session_id, r.attributed_user_id, r.selected_model,
        count(r.id) as steps,
        sum(coalesce(r.provider_total_tokens, 0)) as tokens,
        cast(sum(r.provider_total_cost_usd) as text) as spend,
        cast(min(r.received_at) as text) as first_at,
        cast(max(r.received_at) as text) as last_at
      from routing_requests r
      where r.organization_id = ${organizationId}
        and r.agent_session_id in (${ids.slice(start, start + SESSION_BATCH)})
      group by r.source_protocol, r.agent_session_id, r.attributed_user_id, r.selected_model`);
    for (const row of rows) {
      const key = sessionKey(String(row.source_protocol), String(row.agent_session_id));
      const firstAt = readInstant(row.first_at);
      const lastAt = readInstant(row.last_at);
      const entry = totals.get(key) ?? {
        userId: readOptionalString(row.attributed_user_id), steps: 0, tokens: 0, spend: null, firstAt, lastAt, models: new Map(),
      };
      const steps = readInt(row.steps);
      entry.steps += steps;
      entry.tokens += readInt(row.tokens);
      if (row.spend !== null && row.spend !== undefined) {
        entry.spend = addDecimals(entry.spend ?? { coefficient: 0n, exponent: 0 }, parseDecimal(String(row.spend)));
      }
      entry.firstAt = Math.min(entry.firstAt, firstAt);
      entry.lastAt = Math.max(entry.lastAt, lastAt);
      if (row.selected_model !== null && row.selected_model !== undefined) {
        entry.models.set(String(row.selected_model), (entry.models.get(String(row.selected_model)) ?? 0) + steps);
      }
      totals.set(key, entry);
    }
  }
  return totals;
}

async function userNames(db: ActivityDb, ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const row of await db.all(sql`select id, display_name, email from users where id in (${ids})`)) {
    names.set(String(row.id), readOptionalString(row.display_name) || String(row.email));
  }
  return names;
}

/** The pull requests' summaries, in the order given. */
async function summaries(db: ActivityDb, organizationId: string, pullRequests: readonly PullRequest[]) {
  const totals = await sessionTotals(db, organizationId, pullRequests.flatMap((pr) => [...pr.sessions]));
  const names = await userNames(db, [...new Set([...totals.values()].map((t) => t.userId).filter((id): id is string => id !== null))]);
  return pullRequests.map((pr) => {
    const sessions = [...pr.sessions].map((session) => totals.get(session)).filter((t): t is SessionTotals => t !== undefined);
    let spend: Decimal | null = null;
    const models = new Map<string, number>();
    const people = new Map<string, { user_id: string | null; name: string | null }>();
    for (const session of sessions) {
      if (session.spend !== null) spend = addDecimals(spend ?? { coefficient: 0n, exponent: 0 }, session.spend);
      for (const [model, steps] of session.models) models.set(model, (models.get(model) ?? 0) + steps);
      people.set(String(session.userId), {
        user_id: session.userId,
        name: session.userId === null ? null : names.get(session.userId) ?? null,
      });
    }
    const first = sessions.length === 0 ? null : Math.min(...sessions.map((s) => s.firstAt));
    const last = sessions.length === 0 ? null : Math.max(...sessions.map((s) => s.lastAt));
    return {
      repository: pr.repository,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      branch: pr.branch,
      opened_at: formatInstant(pr.openedAt),
      conversation_count: sessions.length,
      model_steps: sessions.reduce((sum, s) => sum + s.steps, 0),
      provider_total_tokens: sessions.reduce((sum, s) => sum + s.tokens, 0),
      provider_spend_usd: spend === null ? null : fixedDecimal(spend),
      first_at: first === null ? null : formatInstant(first),
      last_at: last === null ? null : formatInstant(last),
      models: [...models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model),
      people: [...people.values()],
    };
  });
}

/** `GET pull-requests`: the organization's pull requests, latest activity first. */
export const pullRequests: ActivityRoute = async (request) => {
  const { params, db } = request;
  const search = (params.string("search", { maxLength: 200 }) ?? "").trim().toLowerCase();
  const limit = params.int("limit", { default: 20, ge: 1, le: 100 });
  const offset = params.int("offset", { default: 0, ge: 0 });
  params.done();
  const organizationId = request.admitted();
  const matching = [...(await loadPullRequests(db, organizationId)).values()]
    .filter((pr) => search === "" || [pr.repository, pr.title ?? "", `#${pr.number}`, pr.branch ?? ""].some((field) => field.toLowerCase().includes(search)))
    .sort((a, b) => b.lastEventAt - a.lastEventAt || a.repository.localeCompare(b.repository) || b.number - a.number);
  return {
    pull_requests: await summaries(db, organizationId, matching.slice(offset, offset + limit)),
    limit,
    offset,
    next_offset: matching.length > offset + limit ? offset + limit : null,
  };
};

function pathPullRequest(request: ActivityRequest): string {
  const { owner, repo, number } = request.path;
  if (!/^\d+$/.test(number!)) throw notFound("Unknown pull request.");
  return prKey(`${owner}/${repo}`.toLowerCase(), Number(number));
}

/** `GET pull-requests/{owner}/{repo}/{number}`: one pull request and its sessions. */
export const pullRequest: ActivityRoute = async (request) => {
  request.params.done();
  const organizationId = request.admitted();
  const { db } = request;
  const pr = (await loadPullRequests(db, organizationId)).get(pathPullRequest(request));
  if (pr === undefined) throw notFound("No agent session worked on this pull request.");
  const [summary] = await summaries(db, organizationId, [pr]);
  const ids = [...pr.sessions].map((session) => session.split(" ")[1]!);
  const records = await loadRecords(db, sql`r.organization_id = ${organizationId} and r.agent_session_id in (${ids})`);
  const byGroup = new Map<string, ConversationRecord[]>();
  for (const record of records) {
    if (!pr.sessions.has(sessionKey(String(record.sourceProtocol), String(record.agentSessionId)))) continue;
    const text = groupKeyText(recordKey(record));
    byGroup.set(text, [...(byGroup.get(text) ?? []), record]);
  }
  const keys = [...byGroup.values()].map((group) => recordKey(group[0]!));
  const titles = keys.length === 0 ? new Map<string, string>() : await conversationTitles(db, organizationId, keys);
  const entities = await loadEntities(db, records);
  const conversations = [...byGroup.entries()].map(([text, group]) => conversationSummary(group, entities, titles.get(text), null));
  const linked = await withPullRequests(db, organizationId, conversations);
  return {
    pull_request: summary,
    conversations: linked.sort((a, b) => b.last_at.localeCompare(a.last_at)),
  };
};

