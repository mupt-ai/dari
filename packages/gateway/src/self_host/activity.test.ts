import { afterEach, expect, test } from "bun:test";

import { startStubGateway } from "./stub_gateway.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

// A request served by the self-hosted gateway shows up in its own Activity:
// the summary, the conversation, and the retained request body.
test("a self-hosted gateway serves Activity for the requests it routed", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const auth = { authorization: `Bearer ${gateway.gatewayKey}` };
  const served = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", messages: [{ role: "user", content: "hello" }] }),
  });
  expect(served.status).toBe(200);
  await served.text();

  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  const read = async (route: string, query = "") => {
    // The request is recorded after its response; give it a moment.
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(
        `${gateway.baseUrl}/v1/organizations/current/routing/activity/${route}?from=${from}&to=${to}${query}`,
        { headers: auth },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      if (route !== "overview" || body.summary.model_steps > 0 || attempt === 20) return body;
      await Bun.sleep(50);
    }
  };

  const overview = await read("overview", "&bucket_seconds=3600");
  expect(overview.summary).toMatchObject({ messages_sent: 1, model_steps: 1 });
  expect(overview.api_keys).toEqual([expect.objectContaining({ api_key_id: "gateway_key_1", label: "Gateway key 1" })]);

  const { conversations } = await read("conversations");
  expect(conversations).toHaveLength(1);
  expect(conversations[0]).toMatchObject({ router_id: "default", router_name: "default" });

  const detail = await fetch(
    `${gateway.baseUrl}/v1/organizations/current/routing/activity/conversations/${conversations[0].conversation_ref}`,
    { headers: auth },
  );
  const { steps } = (await detail.json()) as { steps: Array<{ client_request_url: string | null }> };
  expect(steps[0]!.client_request_url).not.toBeNull();
  const body = await fetch(`${gateway.baseUrl}${steps[0]!.client_request_url}`, { headers: auth });
  expect(body.status).toBe(200);
  expect(await body.text()).toContain("hello");

  // Only a gateway key reads it.
  const anonymous = await fetch(`${gateway.baseUrl}/v1/organizations/current/routing/activity/overview?from=${from}&to=${to}&bucket_seconds=3600`);
  expect(anonymous.status).toBe(401);
});

// The Dari CLI's git hook reports a commit with the key and session ID the
// agent's requests carried, and Activity files it on that session.
test("a commit reported for a Claude Code session links it to its pull request", async () => {
  const gateway = await startStubGateway({ plans: ["anthropic_claude_code"] });
  stop = gateway.stop;
  const auth = { authorization: `Bearer ${gateway.gatewayKey}` };
  const session = "77777777-7777-4777-8777-777777777777";
  const served = await fetch(`${gateway.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.300 (external, cli)",
      "x-app": "cli",
      "x-claude-code-session-id": session,
    },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content: "fix login" }] }),
  });
  expect(served.status).toBe(200);
  await served.text();

  const sha = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  const report = (body: object, headers: Record<string, string> = auth) => fetch(`${gateway.baseUrl}/v1/dari/git-events`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const commit = { repository: "Acme/Web", branch: "fix-login", sha, pull_request: 7, title: "Fix login" };
  expect((await report({ harness: "claude_code", session_id: session.toUpperCase(), commits: [commit] })).status).toBe(204);
  // Reporting it again keeps one.
  expect((await report({ harness: "claude_code", session_id: session, commits: [commit] })).status).toBe(204);
  expect((await report({ harness: "claude_code", session_id: session, commits: [{ ...commit, sha: "abc" }] })).status).toBe(400);
  expect((await report({ harness: "claude_code", session_id: session, commits: [commit] }, {})).status).toBe(401);

  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  let conversations: Array<{ conversation_ref: string; pull_requests: unknown[] }> = [];
  // The request is recorded after its response; give it a moment.
  for (let attempt = 0; conversations.length === 0 && attempt < 20; attempt += 1) {
    const response = await fetch(`${gateway.baseUrl}/v1/organizations/current/routing/activity/conversations?from=${from}&to=${to}`, { headers: auth });
    conversations = ((await response.json()) as { conversations: typeof conversations }).conversations;
    if (conversations.length === 0) await Bun.sleep(50);
  }
  expect(conversations[0]!.pull_requests).toEqual([
    { repository: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7", title: "Fix login" },
  ]);
  const detail = await fetch(
    `${gateway.baseUrl}/v1/organizations/current/routing/activity/conversations/${conversations[0]!.conversation_ref}`,
    { headers: auth },
  );
  expect(((await detail.json()) as { commits: unknown[] }).commits).toEqual([expect.objectContaining({
    repository: "acme/web", sha, branch: "fix-login", url: `https://github.com/acme/web/commit/${sha}`,
  })]);
});

// A Codex subagent's shell names its own thread, while its requests are
// stamped with its parent's session; its commit still goes to that session.
test("a commit reported for a Codex subagent's thread links its parent session", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const auth = { authorization: `Bearer ${gateway.gatewayKey}` };
  const parent = "019a0000-0000-7000-8000-000000000001";
  const child = "019a0000-0000-7000-8000-000000000002";
  const served = await fetch(`${gateway.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: child, parent_thread_id: parent, request_kind: "turn", subagent_kind: "review",
      }),
    },
    body: JSON.stringify({ model: "dari/routing", input: [{ role: "user", content: [{ type: "input_text", text: "review" }] }] }),
  });
  expect(served.status).toBe(200);
  await served.text();

  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  const conversations = async () => {
    const response = await fetch(`${gateway.baseUrl}/v1/organizations/current/routing/activity/conversations?from=${from}&to=${to}`, { headers: auth });
    return ((await response.json()) as { conversations: Array<{ pull_requests: unknown[] }> }).conversations;
  };
  // The request is recorded after its response; give it a moment.
  for (let attempt = 0; (await conversations()).length === 0 && attempt < 20; attempt += 1) await Bun.sleep(50);

  const report = (sessionId: string) => fetch(`${gateway.baseUrl}/v1/dari/git-events`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      harness: "codex",
      session_id: sessionId,
      commits: [{ repository: "acme/web", branch: "fix", sha: "a".repeat(40), pull_request: 9 }],
    }),
  });
  expect((await report(child)).status).toBe(204);
  // A thread no request names yet is asked for again.
  const pending = await report("019a0000-0000-7000-8000-000000000003");
  expect(pending.status).toBe(409);
  expect(((await pending.json()) as { error: { code: string } }).error.code).toBe("session_pending");
  expect((await conversations())[0]!.pull_requests).toEqual([
    { repository: "acme/web", number: 9, url: "https://github.com/acme/web/pull/9", title: null },
  ]);
});

// A Claude Code session's own tool output is all it takes: the push and the
// `gh pr create` it ran file it on the pull request, and a later session that
// pushes the same branch joins it. Nothing on the client reports either.
test("sessions that push and open a pull request show on that pull request", async () => {
  const gateway = await startStubGateway({ plans: ["anthropic_claude_code"] });
  stop = gateway.stop;
  const auth = { authorization: `Bearer ${gateway.gatewayKey}` };
  const bash = (id: string, command: string, output: string) => [
    { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
  ];
  const send = async (session: string, messages: unknown[]) => {
    const served = await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-cli/2.1.300 (external, cli)",
        "x-app": "cli",
        "x-claude-code-session-id": session,
      },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 100, messages }),
    });
    expect(served.status).toBe(200);
    await served.text();
  };

  const opener = "88888888-8888-4888-8888-888888888888";
  const prompt = { role: "user", content: "fix login and open a PR" };
  const pushed = bash("toolu_push", "git push -u origin fix-login", [
    "remote: Create a pull request for 'fix-login' on GitHub by visiting:",
    "remote:      https://github.com/Acme/Web/pull/new/fix-login",
    "To github.com:Acme/Web.git",
    " * [new branch]      fix-login -> fix-login",
  ].join("\n"));
  const opened = bash("toolu_pr", "gh pr create --title \"Fix login\" --body \"\"", "https://github.com/Acme/Web/pull/12\n");
  await send(opener, [prompt]);
  await send(opener, [prompt, ...pushed]);
  await send(opener, [prompt, ...pushed, ...opened]);

  const follower = "99999999-9999-4999-8999-999999999999";
  const review = { role: "user", content: "address the review" };
  await send(follower, [review, ...bash("toolu_fix", "git push", "To github.com:Acme/Web.git\n   1a2b3c4..5d6e7f8  fix-login -> fix-login\n")]);

  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  const read = async <T>(route: string): Promise<T> => {
    const response = await fetch(`${gateway.baseUrl}/v1/organizations/current/routing/activity/${route}?from=${from}&to=${to}`, { headers: auth });
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };
  type PullRequests = { pull_requests: Array<Record<string, unknown>> };
  // Requests are recorded after their responses; give them a moment.
  let list: PullRequests = { pull_requests: [] };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    list = await read<PullRequests>("pull-requests");
    if (list.pull_requests[0]?.conversation_count === 2) break;
    await Bun.sleep(50);
  }
  expect(list.pull_requests).toEqual([expect.objectContaining({
    repository: "acme/web",
    number: 12,
    url: "https://github.com/acme/web/pull/12",
    title: "Fix login",
    branch: "fix-login",
    conversation_count: 2,
    model_steps: 4,
  })]);

  const { conversations } = await read<{ conversations: Array<{ pull_requests: Array<{ number: number }> }> }>("conversations");
  expect(conversations).toHaveLength(2);
  for (const conversation of conversations) expect(conversation.pull_requests.map((pr) => pr.number)).toEqual([12]);

  const detail = await read<{ conversations: unknown[] }>("pull-requests/acme/web/12");
  expect(detail.conversations).toHaveLength(2);
  const missing = await fetch(`${gateway.baseUrl}/v1/organizations/current/routing/activity/pull-requests/acme/web/13?from=${from}&to=${to}`, { headers: auth });
  expect(missing.status).toBe(404);
});
