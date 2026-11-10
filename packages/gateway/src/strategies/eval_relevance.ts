import { RouterFrameworkError } from "@mupt-ai/dari-router";
import {
  JevOutputError,
  selectRelevantEvals,
  type ChatMessage,
  type JevEvalRelevanceSelection,
  type ResolvedJevConfig,
  type RouterEval,
} from "@mupt-ai/dari-router/policy-engine";

import { publicCatalogSelectorEvals } from "../context/eval_catalog.js";
import { scrubSecrets } from "../telemetry/scrub.js";
import type { ResolvedRouter } from "../types.js";

export type EvalRelevanceDetails =
  | {
      model: string;
      cards: JevEvalRelevanceSelection["cards"];
      usage: JevEvalRelevanceSelection["usage"];
    }
  | { error: "eval_relevance_failed" };

// The candidate pool is every eval the organization can use: its own cards
// plus the public catalog. Jev keeps the cards relevant to this request and
// those become the selector's evidence. A Jev outage degrades to the
// organization's own cards rather than failing the request.
export async function relevantEvals(args: {
  credentials: ResolvedRouter;
  selectorMessages: ChatMessage[];
  config: ResolvedJevConfig;
}): Promise<{ evals: RouterEval[]; details: EvalRelevanceDetails }> {
  const organizationEvals = args.credentials.evals ?? [];
  const pool = [
    ...organizationEvals,
    ...publicCatalogSelectorEvals(args.credentials.public_eval_catalog),
  ];
  try {
    const selection = await selectRelevantEvals(
      pool,
      {
        task: args.selectorMessages.find((message) => message.role === "user") ?? null,
        conversation: args.selectorMessages,
      },
      args.config,
    );
    return {
      evals: selection.evals,
      details: { model: selection.model, cards: selection.cards, usage: selection.usage },
    };
  } catch (error) {
    if (!(error instanceof RouterFrameworkError || error instanceof JevOutputError)) {
      throw error;
    }
    console.error("eval relevance failed", scrubSecrets(error.message));
    return { evals: organizationEvals, details: { error: "eval_relevance_failed" } };
  }
}
