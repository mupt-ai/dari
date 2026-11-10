// Selector system prompts live in prompts/*.md, and the structured Jev
// questions in prompts/*.json, so prompt review never requires reading
// request-assembly code. Per-request candidate data rides in the user
// message, keeping these byte-stable for provider prompt caching.

import { readFileSync } from "node:fs";

import {
  FIXED_TURN_COST_PROJECTED_TURNS,
} from "./fixed_turn_cost_config.js";

// Placeholders interpolated where a prompt names the projection horizons, so
// the wording cannot drift from the config that produces the data.
const PROMPT_VARIABLES: Record<string, string> = {
  projected_turns: FIXED_TURN_COST_PROJECTED_TURNS.join(", "),
};

function loadPrompt(name: string): string {
  const template = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");
  return fillPrompt(template.trimEnd(), PROMPT_VARIABLES, `prompts/${name}.md`);
}

// Loads a structured prompt. Shared variables are filled at load time;
// placeholders named in templateKeys stay for fillPrompt at request time;
// any other placeholder is an error.
function loadJsonPrompt<T>(name: string, templateKeys: readonly string[] = []): T {
  const source = `prompts/${name}.json`;
  const parsed: unknown = JSON.parse(
    readFileSync(new URL(`./prompts/${name}.json`, import.meta.url), "utf8"),
  );
  const keep = Object.fromEntries(templateKeys.map((key) => [key, `{{${key}}}`]));
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") return fillPrompt(value, { ...PROMPT_VARIABLES, ...keep }, source);
    if (Array.isArray(value)) return value.map(fill);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)]));
    }
    return value;
  };
  return fill(parsed) as T;
}

// Replaces every {{key}} in a template, failing on any key without a value.
export function fillPrompt(
  template: string,
  values: Readonly<Record<string, string>>,
  source = "prompt template",
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Unknown placeholder {{${key}}} in ${source}`);
    return value;
  });
}

export const SELECTOR_SYSTEM_PROMPT = loadPrompt("selector");

// Appended to the selector prompt when a router has user-authored rules;
// custom routers otherwise select exactly like every other router.
export const CUSTOM_RULES_PROMPT = loadPrompt("custom_rules");

// System prompt for the anonymous candidate-action protocol (see
// anonymous_actions.ts), shared by GRPO training and the deployed policy. It
// carries every invariant instruction, including how to read the per-action
// blocks, so the user message stays pure data.
export const ANONYMOUS_ACTION_SYSTEM_PROMPT = loadPrompt("anonymous_action");

// The anonymous protocol's rules addendum; the rules themselves follow it,
// rewritten into action labels.
export const ANONYMOUS_RULES_PROMPT = loadPrompt("anonymous_rules");

// Jev's eval-relevance Noul question, asked once per candidate eval card.
export const JEV_EVAL_RELEVANCE_PROMPT = loadJsonPrompt<{
  question: string;
  rules: string[];
  criteria: { true: string; false: string };
}>("jev_eval_relevance");

// Jev's selection questions. Lease criteria are templates over {{turns}}.
export const JEV_SELECTOR_PROMPT = loadJsonPrompt<{
  action: { question: string; rules: string[]; router_rules_rule: string };
  lease: {
    question: string;
    guidance: string;
    criteria: { shortest: string; middle: string; longest: string };
  };
}>("jev_selector", ["turns"]);
