/**
 * What every coding agent must do through Dari, checked for each way a
 * request can be served: on this computer's plan, and by hosted Dari over
 * each of the two APIs this computer reaches it on. Each test launches the
 * real agent once (stack.ts).
 */
import { expect, test } from "bun:test";

import { DONE, TOOL_OUTPUT, type ModelCall } from "./model.ts";
import {
  DARI_ANTHROPIC_KEY,
  DARI_OPENAI_KEY,
  launch,
  ON_DARI_CLAUDE,
  ON_DARI_GPT,
  ROLE_PROMPTS,
  type ActivityStep,
  type Agent,
  type Session,
} from "./stack.ts";

export type AgentSpec = {
  agent: Agent;
  // The coding agent as Dari names it.
  harness: string;
  // The `dari <agent>` arguments that run one prompt and exit.
  args(prompt: string, servedBy: ActivityStep["servedBy"]): string[];
  // The plan on this computer that serves the agent, and the model it serves.
  onPlan: { model: string; token: string };
  // What the agent says its own turns are. Muse Code does not say.
  mainClass: "main" | "unknown";
  // The type the agent gives a subagent it starts; absent when it has none.
  subagentType?: string;
};

const TIMEOUT_MS = 180_000;

export function agentSuite(spec: AgentSpec): void {
  const served = [
    { how: "on this computer's plan", model: spec.onPlan.model, token: spec.onPlan.token, by: "computer" as const },
    { how: "by hosted Dari over Anthropic's API", model: ON_DARI_CLAUDE, token: DARI_ANTHROPIC_KEY, by: "dari" as const },
    { how: "by hosted Dari over the Responses API", model: ON_DARI_GPT, token: DARI_OPENAI_KEY, by: "dari" as const },
  ];

  for (const path of served) {
    test.concurrent(`${spec.agent} runs a prompt and the tool the model calls, served ${path.how}`, async () => {
      const session = await launch(spec.agent, spec.args("e2e:tool", path.by), { model: path.model });
      // The agent ran the model's command and sent its output back.
      expectAnswer(session, `${DONE} ${TOOL_OUTPUT}`);
      const turn = session.calls.filter((call) => call.step === "shell" || call.step === "answer");
      expect(turn.map((call) => call.step)).toEqual(["shell", "answer"]);
      for (const call of turn) {
        expect(call.token).toBe(path.token);
        expect(rolePrompts(call)).toEqual({ main: 1, subagent: 0 });
      }

      // Activity shows both requests as the agent's own turns, in one session.
      const steps = session.activity.filter((step) => step.model === path.model);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      for (const step of steps) {
        expect(step).toMatchObject({ servedBy: path.by, requestClass: spec.mainClass, agentId: null });
      }
      expect(steps[0]!.session).not.toBeNull();
      expect(steps[1]!.session).toBe(steps[0]!.session);
      expectNamed(session, spec, path.by);
    }, TIMEOUT_MS);

    const subagentType = spec.subagentType;
    if (subagentType === undefined) continue;
    test.concurrent(`${spec.agent} runs a subagent as its own agent, served ${path.how}`, async () => {
      const session = await launch(spec.agent, spec.args("e2e:subagent", path.by), { model: path.model });
      expectAnswer(session, DONE);
      const child = session.calls.find((call) => call.step === "child");
      if (child === undefined) throw new Error(`The subagent never ran.\n${describe(session)}`);
      expect(child.token).toBe(path.token);
      expect(rolePrompts(child)).toEqual({ main: 0, subagent: 1 });

      // Activity tells the subagent's request from the main agent's, in the
      // main agent's session.
      const steps = session.activity.filter((step) => step.model === path.model);
      const main = steps.filter((step) => step.requestClass === "main");
      const subagent = steps.filter((step) => step.requestClass === "subagent");
      expect(steps).toHaveLength(main.length + subagent.length);
      expect(main.length).toBeGreaterThanOrEqual(2);
      expect(subagent).toHaveLength(1);
      expect(subagent[0]).toMatchObject({ servedBy: path.by, agentType: subagentType });
      expect(subagent[0]!.agentId).not.toBeNull();
      for (const step of main) expect(step.agentId).toBeNull();
      expect(main[0]!.session).not.toBeNull();
      expect([...new Set(steps.map((step) => step.session))]).toEqual([main[0]!.session]);
      expectNamed(session, spec, path.by);
    }, TIMEOUT_MS);
  }
}

/** The agent exited cleanly having printed `text`, the model's answer. */
export function expectAnswer(session: Session, text: string): void {
  if (session.exitCode !== 0 || !session.stdout.includes(text)) {
    throw new Error(`Expected the agent to print ${JSON.stringify(text)} and exit 0.\n${describe(session)}`);
  }
}

// Hosted Dari is told which coding agent each request it serves comes from.
function expectNamed(session: Session, spec: AgentSpec, servedBy: ActivityStep["servedBy"]): void {
  if (servedBy !== "dari") return;
  expect(session.dariRequests.length).toBeGreaterThan(0);
  for (const headers of session.dariRequests) expect(headers["x-dari-client-harness"]).toBe(spec.harness);
}

// How many times the model was sent each role's prompt.
function rolePrompts(call: ModelCall): { main: number; subagent: number } {
  const sent = JSON.stringify(call.body);
  return { main: sent.split(ROLE_PROMPTS.main).length - 1, subagent: sent.split(ROLE_PROMPTS.subagent).length - 1 };
}

function describe(session: Session): string {
  return [
    `exit ${session.exitCode}`,
    `stdout: ${session.stdout.slice(-2000)}`,
    `stderr: ${session.stderr.slice(-2000)}`,
    `provider calls: ${JSON.stringify(session.calls.map((call) => [call.model, call.step, call.reply]))}`,
  ].join("\n");
}
