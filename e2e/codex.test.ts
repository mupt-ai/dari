import { agentSuite } from "./suite.ts";
import { CHATGPT_PLAN_TOKEN, ON_PLAN_GPT } from "./stack.ts";

agentSuite({
  agent: "codex",
  harness: "codex",
  args: (prompt, servedBy) => [
    "exec",
    "--skip-git-repo-check",
    // Codex's own sandbox needs kernel support a CI runner may not give it.
    // The only command the scripted model runs is an `echo`.
    "--sandbox",
    "danger-full-access",
    // Codex asks for OpenAI's hosted web search on every turn, and only an
    // OpenAI model can serve a turn that does. Without the tool the selector
    // may send the turn to Claude too. (failover.test.ts keeps it on.)
    ...(servedBy === "dari" ? ["-c", 'web_search="disabled"'] : []),
    prompt,
  ],
  onPlan: { model: ON_PLAN_GPT, token: CHATGPT_PLAN_TOKEN },
  mainClass: "main",
  subagentType: "thread_spawn",
});
