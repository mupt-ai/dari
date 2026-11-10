import type {
  InteractionOutput,
  InteractionRequest,
} from "../../../interaction/types.js";
import {
  codexExecCommand,
  readSkillsFromCodexCommand,
} from "./exec_file_reads.js";
import { codexFileSkillCatalog } from "./catalog.js";
import { codexSkillCapabilityId } from "./identity.js";
import type { SkillObservation } from "../observations.js";

/** Match model-emitted Codex file reads to the exact current skill catalog. */
export function codexAutomaticSkillObservations(
  request: InteractionRequest,
  output: InteractionOutput,
  limit: number,
): SkillObservation[] {
  if (
    limit <= 0
    || request.sourceProtocol !== "openai_responses"
    || !request.tools.some(
      (tool) =>
        tool.kind === "function"
        && tool.name === "exec_command"
        && tool.namespace === undefined,
    )
  ) return [];
  const catalog = codexFileSkillCatalog(request);
  if (catalog === undefined) return [];

  const observedPaths = new Set<string>();
  const observed: SkillObservation[] = [];
  for (const item of output.items) {
    const input = codexExecCommand(item);
    if (input === undefined) continue;
    for (const skill of readSkillsFromCodexCommand(input, catalog)) {
      if (observedPaths.has(skill.path.key)) continue;
      observedPaths.add(skill.path.key);
      observed.push({
        eventType: "skill_load",
        toolCallId: input.callId,
        capabilityId: codexSkillCapabilityId(skill.name),
        observedName: skill.name,
        evidenceSource: "skill_file_read",
      });
      if (observed.length === limit) return observed;
    }
  }
  return observed;
}
