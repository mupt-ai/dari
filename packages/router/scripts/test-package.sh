#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

cd "$package_root"
bun run build
package_archive="$(npm pack --silent --pack-destination "$temporary_dir")"

mkdir "$temporary_dir/consumer"
cd "$temporary_dir/consumer"
npm init --yes >/dev/null
npm install --ignore-scripts "$temporary_dir/$package_archive" >/dev/null

node --input-type=module <<'EOF'
import {
  createThinkingLevelRatios,
  resolveRouterEvalScore,
} from "@mupt-ai/dari-router/eval-score-imputation";

const ratios = createThinkingLevelRatios([{
  min_score: 0, max_score: 100,
  scores: [
    { model_id: "openai/calibrator", thinking_level: "low", score: 20 },
    { model_id: "openai/calibrator", thinking_level: "high", score: 40 },
    { model_id: "anthropic/calibrator", thinking_level: "low", score: 40 },
    { model_id: "anthropic/calibrator", thinking_level: "high", score: 20 },
  ],
}]);
const resolved = resolveRouterEvalScore({
  scores: [{ model_id: "openai/target", thinking_level: "low", score: 30 }],
  modelId: "openai/target", thinkingLevel: "high",
  minScore: 0, maxScore: 100, impute: true, ratios,
});
if (resolved?.score !== 60 || !resolved.imputed) {
  throw new Error("Provider-local imputation failed in the packed package");
}
EOF

# Prompts load from files next to the compiled modules; the packed package
# must ship them.
node --input-type=module <<'EOF'
import {
  buildJevEvalRelevanceRequest,
  SELECTOR_SYSTEM_PROMPT,
} from "@mupt-ai/dari-router/policy-engine";

const request = buildJevEvalRelevanceRequest(
  [{ id: "e", name: "n", min_score: 0, max_score: 1, scores: [] }],
  { task: null, conversation: [] },
  "jev-latest",
);
if (!request.questions.e.instructions.question || !SELECTOR_SYSTEM_PROMPT) {
  throw new Error("Prompt files are missing from the packed package");
}
EOF

test ! -e node_modules/@mupt-ai/pi-ai
