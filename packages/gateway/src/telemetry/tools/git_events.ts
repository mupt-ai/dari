/* Pull requests and pushes an agent made, read from its own tool output:
   a `gh pr create` result prints the new pull request's URL, other `gh pr`
   commands name the pull request they work on, and a `git push` result names
   the GitHub repository and the branches it updated. Activity links each
   agent session to the pull requests it opened or worked on, and to those
   whose branch it pushed or committed to (commits arrive from the Dari CLI's
   git hook, `ingress/git_events.ts`). Only GitHub is recognized. */

import type { InteractionContent, InteractionItem, InteractionRequest } from "../../interaction/types.js";
import { newlySubmittedToolResults } from "./observations.js";

const MAX_EVENTS = 50;
const MAX_TITLE_CHARS = 300;

type Fields = { repository: string; ordinal: number };
export type GitEventReport =
  | Fields & { kind: "opened"; number: number; title: string | null; branch: string | null }
  | Fields & { kind: "referenced"; number: number; title: null; branch: null }
  | Fields & { kind: "push"; number: null; title: null; branch: string };

/** A commit made in an agent session, with its branch's open pull request when the hook found one. */
export type CommitEvent = {
  kind: "commit";
  repository: string;
  branch: string;
  commit_sha: string;
  number: number | null;
  title: string | null;
  ordinal: number;
};

const PULL_REQUEST_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/g;
// GitHub's reply to the first push of a branch: `remote:   https://github.com/owner/repo/pull/new/branch`.
const NEW_BRANCH_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/new\/(\S+)/g;
// `gh pr` commands that work on one pull request, unlike `list` or `api` which print many.
const WORKS_ON_PULL_REQUEST = /\bgh\s+pr\s+(?:view|checks|merge|comment|edit|diff|ready|review|close|reopen|checkout|update-branch)\b/;
// `To github.com:owner/repo.git`, `To git@github.com:owner/repo.git`, `To https://github.com/owner/repo`, or `To ssh://git@github.com/owner/repo.git`.
const PUSH_DESTINATION = /^To\s+(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|(?:ssh:\/\/)?(?:git@)?github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/;
// `   1a2b..3c4d  local -> remote`, ` + 1a2b...3c4d local -> remote (forced update)`, ` * [new branch]      local -> remote`.
const PUSHED_REF = /^\s*[+* ]?\s*(?:[0-9a-f]+\.\.\.?[0-9a-f]+|\[new branch\])\s+\S+\s+->\s+(\S+)/;
const TITLE = /(?:--title|-t)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/;
const HEAD = /--head(?:=|\s+)["']?([^\s"']+)/;

/** The GitHub pull requests and pushes in the request's newly submitted tool results. */
export function gitEvents(request: InteractionRequest, zdr: boolean): GitEventReport[] {
  if (zdr) return [];
  return gitEventsIn(request.items, newlySubmittedToolResults(request).results.map(({ ordinal }) => ordinal));
}

function gitEventsIn(items: readonly InteractionItem[], resultOrdinals: readonly number[]): GitEventReport[] {
  const calls = new Map<string, string>();
  for (const item of items) {
    if (item.type === "tool_call") {
      calls.set(item.callId, `${item.name} ${typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? {})}`);
    }
  }
  const events: GitEventReport[] = [];
  for (const ordinal of resultOrdinals) {
    const result = items[ordinal];
    if (result?.type !== "tool_result" || result.isError) continue;
    const call = calls.get(result.callId);
    if (call === undefined) continue;
    const output = outputText(result.output);
    const pushed: Array<{ repository: string; branch: string }> = [];
    if (/\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(call)) {
      let repository: string | null = null;
      for (const line of output.split(/\r?\n/)) {
        const destination = PUSH_DESTINATION.exec(line);
        if (destination !== null) {
          repository = `${destination[1]}/${destination[2]}`.toLowerCase();
          continue;
        }
        const ref = repository === null ? null : PUSHED_REF.exec(line);
        if (ref !== null && repository !== null) pushed.push({ repository, branch: ref[1]!.replace(/^refs\/heads\//, "") });
      }
      for (const [, owner, repo, branch] of output.matchAll(NEW_BRANCH_URL)) {
        pushed.push({ repository: `${owner}/${repo}`.toLowerCase(), branch: branch! });
      }
    }
    for (const push of pushed) {
      if (!push.branch.startsWith("refs/")) events.push({ kind: "push", ...push, number: null, title: null, ordinal });
    }
    const opened = /\bgh\s+pr\s+create\b/.test(call) || /create_pull_request/i.test(call);
    if (opened) {
      const title = titleOf(call);
      for (const [, owner, repo, number] of output.matchAll(PULL_REQUEST_URL)) {
        const repository = `${owner}/${repo}`.toLowerCase();
        const branch = HEAD.exec(call)?.[1] ?? [...pushed].reverse().find((push) => push.repository === repository)?.branch ?? null;
        events.push({ kind: "opened", repository, number: Number(number), title, branch, ordinal });
      }
    } else if (WORKS_ON_PULL_REQUEST.test(call)) {
      for (const [, owner, repo, number] of `${call}\n${output}`.matchAll(PULL_REQUEST_URL)) {
        events.push({ kind: "referenced", repository: `${owner}/${repo}`.toLowerCase(), number: Number(number), title: null, branch: null, ordinal });
      }
    }
  }
  // One event per pull request or branch per result.
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = JSON.stringify([event.ordinal, event.kind, event.repository, event.number, event.branch]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_EVENTS);
}

function outputText(output: string | InteractionContent[] | null): string {
  if (output === null) return "";
  if (typeof output === "string") return output;
  return output.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** The `--title` a `gh pr create` command passed, when it passed one plainly. */
function titleOf(call: string): string | null {
  // A command inside a JSON input arrives with its quotes escaped.
  const match = TITLE.exec(call.replaceAll('\\"', '"'));
  const title = match?.[1] ?? match?.[2] ?? match?.[3];
  if (title === undefined || title.includes("$(")) return null;
  return title.replaceAll('\\"', '"').trim().slice(0, MAX_TITLE_CHARS) || null;
}
