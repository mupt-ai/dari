import { claudeCode } from "./claude_code.js";
import { codex } from "./codex.js";
import { hermes } from "./hermes.js";
import { museCode } from "./muse_code.js";
import { openclaw } from "./openclaw.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";

/** A coding agent the gateway serves. */
export type Harness = {
  id: string;
  // The headers it describes itself and each request with: which agent it
  // is, its session, and what the request is for. A connected gateway passes
  // them on to hosted Dari.
  headers: readonly string[];
  // Its own plan serves only it, so only its own headers name it.
  ownPlanOnly?: true;
};

export const HARNESSES = [claudeCode, codex, museCode, opencode, pi, openclaw, hermes] as const;

export type ClientHarness = (typeof HARNESSES)[number]["id"];

export const CLIENT_HARNESSES: readonly string[] = HARNESSES.map((harness) => harness.id);

/** The agents whose own plan serves only them. */
export const OWN_PLAN_HARNESSES: readonly ClientHarness[] = HARNESSES
  .filter((harness) => "ownPlanOnly" in harness)
  .map((harness) => harness.id);
