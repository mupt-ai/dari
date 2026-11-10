import { providerForModel } from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors.js";

export function requireCandidateModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(
      400,
      "routing.candidate_models must include at least one model.",
      "invalid_routing_request",
      "routing.candidate_models"
    );
  }
  const candidates = value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new HttpError(
        400,
        "routing.candidate_models must contain non-empty strings.",
        "invalid_routing_request",
        `routing.candidate_models[${index}]`
      );
    }
    providerForModel(item);
    return item;
  });
  return [...new Set(candidates)];
}
