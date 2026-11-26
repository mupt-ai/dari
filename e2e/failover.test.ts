import { expect, test } from "bun:test";

import { DONE, TOOL_OUTPUT } from "./model.ts";
import { expectAnswer } from "./suite.ts";
import {
  CHATGPT_PLAN_TOKEN,
  CLAUDE_PLAN_TOKEN,
  DARI_ANTHROPIC_KEY,
  DARI_OPENAI_KEY,
  launch,
  ON_PLAN_CLAUDE,
  ON_PLAN_GPT,
} from "./stack.ts";

// A plan at its usage limit must not stop the agent: hosted Dari serves the
// same model, and the agent never sees the refusal.
const PLANS = [
  { plan: "Claude Code", agent: "claude" as const, args: ["-p", "e2e:tool", "--dangerously-skip-permissions"], model: ON_PLAN_CLAUDE, token: CLAUDE_PLAN_TOKEN, dariKey: DARI_ANTHROPIC_KEY },
  { plan: "ChatGPT", agent: "codex" as const, args: ["exec", "--skip-git-repo-check", "--sandbox", "danger-full-access", "e2e:tool"], model: ON_PLAN_GPT, token: CHATGPT_PLAN_TOKEN, dariKey: DARI_OPENAI_KEY },
];

for (const { plan, agent, args, model, token, dariKey } of PLANS) {
  test.concurrent(`hosted Dari serves ${agent} when this computer's ${plan} plan is at its limit`, async () => {
    const session = await launch(agent, args, { model, plansAtLimit: true });
    expectAnswer(session, `${DONE} ${TOOL_OUTPUT}`);
    const refused = session.calls.filter((call) => call.step === "refused");
    // Once refused, the plan is held until it resets: it is not asked again.
    expect(refused.map((call) => call.token)).toEqual([token]);
    const turn = session.calls.filter((call) => call.step === "shell" || call.step === "answer");
    expect(turn.map((call) => call.token)).toEqual([dariKey, dariKey]);
    // Codex's turn asks for OpenAI's hosted web search; Dari is sent it too.
    const hostedTools = (turn[0]!.body.tools as Array<{ type?: string }>).filter((tool) => tool.type?.startsWith("web_search"));
    expect(hostedTools).toHaveLength(agent === "codex" ? 1 : 0);
    const steps = session.activity.filter((step) => step.model === model && step.requestClass === "main");
    expect(steps.map((step) => step.servedBy)).toEqual(["dari", "dari"]);
  }, 180_000);
}
