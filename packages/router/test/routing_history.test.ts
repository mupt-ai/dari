import { expect, test } from "bun:test";

import {
  compactRoutingHistory,
  ROUTER_HISTORY_CHAR_BUDGET,
  ROUTER_USER_MESSAGE_CHAR_CAP,
} from "../src/routing_history.js";
import type { ChatMessage } from "../src/types.js";

const REQUEST = "Build a basketball sim game with a season mode and box scores.";

function agentTurns(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, turn) => [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: `call-${turn}`, type: "function", function: { name: "Bash", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: `call-${turn}`, content: `output-${turn}-${"o".repeat(2_000)}` },
  ] satisfies ChatMessage[]).flat();
}

function harnessText(label: string, lines: number): string {
  return Array.from({ length: lines }, (_, line) => `${label} "rule" ${line}: keep it simple.`).join("\n");
}

test("keeps a short request between long harness context parts", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are Claude Code." },
    {
      role: "user",
      content: [
        { type: "text", text: `<system-reminder>\n${harnessText("claudeMd", 200)}\n</system-reminder>` },
        { type: "text", text: REQUEST },
        { type: "text", text: `# Environment\n${harnessText("skill", 150)}` },
      ],
    },
    ...agentTurns(10),
  ];

  const compacted = compactRoutingHistory(messages, ROUTER_HISTORY_CHAR_BUDGET);
  const user = compacted.find((message) => message.role === "user");

  expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(ROUTER_HISTORY_CHAR_BUDGET);
  expect(JSON.stringify(user).length).toBeLessThanOrEqual(ROUTER_USER_MESSAGE_CHAR_CAP);
  const parts = user?.content as Array<{ type: string; text: string }>;
  expect(parts).toHaveLength(3);
  expect(parts[0]!.text).toStartWith("<system-reminder>");
  expect(parts[1]!.text).toBe(REQUEST);
  expect(parts[2]!.text).toStartWith("# Environment");
});

test("compacts an escape-heavy user message instead of dropping it", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are Claude Code." },
    { role: "user", content: `${REQUEST}\n${harnessText("pasted", 400)}` },
    ...agentTurns(10),
  ];

  const compacted = compactRoutingHistory(messages, ROUTER_HISTORY_CHAR_BUDGET);
  const user = compacted.find((message) => message.role === "user");

  expect(user).toBeDefined();
  expect(JSON.stringify(user).length).toBeLessThanOrEqual(ROUTER_USER_MESSAGE_CHAR_CAP);
  expect(String(user?.content)).toStartWith(REQUEST);
});
