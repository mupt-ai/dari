import { expect, test } from "bun:test";

import { anthropicMessagesToInteraction } from "../../protocol/input/anthropic_messages.js";
import { allGitEvents, gitEvents } from "./git_events.js";

/** A Claude Code turn history: each Bash command and what it printed, the last one just submitted. */
function claudeCode(...exchanges: Array<{ command: string; output: string; isError?: boolean }>) {
  return anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 1,
    messages: [
      { role: "user", content: "ship it" },
      ...exchanges.flatMap(({ command, output, isError }, index) => [
        { role: "assistant" as const, content: [{ type: "tool_use" as const, id: `toolu_${index}`, name: "Bash", input: { command } }] },
        {
          role: "user" as const,
          content: [{ type: "tool_result" as const, tool_use_id: `toolu_${index}`, content: output, ...(isError ? { is_error: true } : {}) }],
        },
      ]),
    ],
  });
}

// What Claude Code got back from pushing a new branch quietly and opening its pull request in one command.
const PUSH_AND_OPEN = {
  command: `cd ~/w/activity && git push -u origin activity -q 2>&1 | tail -2; gh pr create --base main --title "Serve Activity from the gateway (1/2)" --body "$(cat <<'EOF'\nbody\nEOF\n)"`,
  output: "remote:      https://github.com/Mupt-AI/dari-mono/pull/new/activity        \nremote: \nhttps://github.com/mupt-ai/dari-mono/pull/1216\n",
};

test("a pull request opened from a quietly pushed branch", () => {
  expect(gitEvents(claudeCode(PUSH_AND_OPEN), false)).toEqual([
    { kind: "push", repository: "mupt-ai/dari-mono", branch: "activity", number: null, title: null, ordinal: 2 },
    { kind: "opened", repository: "mupt-ai/dari-mono", number: 1216, title: "Serve Activity from the gateway (1/2)", branch: "activity", ordinal: 2 },
  ]);
});

test("a push names its repository and every branch it updated, but not tags or deletions", () => {
  const output = [
    "Enumerating objects: 5, done.",
    "To github.com:acme/web.git",
    "   1a2b3c4..5d6e7f8  fix-login -> fix-login",
    " + 9a8b7c6...1d2e3f4 rebased -> rebased (forced update)",
    " * [new branch]      feature -> feature",
    " * [new tag]         v1.2 -> v1.2",
    " - [deleted]         old",
  ].join("\n");
  expect(gitEvents(claudeCode({ command: "git push --all", output }), false).map((event) => event.branch)).toEqual([
    "fix-login", "rebased", "feature",
  ]);
});

test("gh pr commands on one pull request link it; listings and API calls do not", () => {
  const request = claudeCode(
    { command: "gh pr list --json url", output: "https://github.com/acme/web/pull/1\nhttps://github.com/acme/web/pull/2" },
    { command: "gh pr checks https://github.com/acme/web/pull/7 --watch", output: "All checks were successful" },
  );
  expect(allGitEvents(request)).toEqual([
    { kind: "referenced", repository: "acme/web", number: 7, title: null, branch: null, ordinal: 4 },
  ]);
});

test("a request reports only its newly submitted results; a stored one reads its whole history", () => {
  const request = claudeCode(PUSH_AND_OPEN, { command: "gh pr view https://github.com/acme/web/pull/9", output: "title: Fix" });
  expect(gitEvents(request, false).map((event) => event.number)).toEqual([9]);
  expect(allGitEvents(request).map((event) => event.number)).toEqual([null, 1216, 9]);
});

test("nothing is read from a ZDR request or from a failed command", () => {
  expect(gitEvents(claudeCode(PUSH_AND_OPEN), true)).toEqual([]);
  expect(gitEvents(claudeCode({ ...PUSH_AND_OPEN, isError: true }), false)).toEqual([]);
});
