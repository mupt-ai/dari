import { agentSuite } from "./suite.ts";
import { CHATGPT_PLAN_TOKEN, ON_PLAN_GPT } from "./stack.ts";

// Muse Code names its session but not what each request is for, and `muse
// exec` starts no subagents in a workspace it has not been told to trust.
agentSuite({
  agent: "muse",
  harness: "muse_code",
  args: (prompt) => ["exec", prompt],
  onPlan: { model: ON_PLAN_GPT, token: CHATGPT_PLAN_TOKEN },
  mainClass: "unknown",
});
