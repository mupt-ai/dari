import { isRecord } from "@mupt-ai/dari-router/policy-engine";

type ModelCapabilityMetadata = {
  model: Record<string, unknown>;
};

export const BEDROCK_API = "bedrock-converse-stream";

export function isBedrockApi(api: unknown): boolean {
  return api === BEDROCK_API;
}

export function modelSupportsImageInput(metadata: ModelCapabilityMetadata): boolean {
  return Array.isArray(metadata.model.input) && metadata.model.input.includes("image");
}

/* PDFs are sent natively only where the model owner documents PDF input on
   that API. The same API can serve other owners (xAI and Meta on Responses,
   GPT on Bedrock) whose PDF support is unverified, so both must match. */
const DOCUMENT_INPUT_APIS_BY_OWNER: Readonly<Record<string, ReadonlySet<string>>> = {
  anthropic: new Set(["anthropic-messages", "bedrock-converse-stream"]),
  openai: new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]),
};

export function apiSupportsDocumentInput(api: string): boolean {
  return Object.values(DOCUMENT_INPUT_APIS_BY_OWNER).some((apis) => apis.has(api));
}

export function modelSupportsDocumentInput(modelId: string, metadata: ModelCapabilityMetadata): boolean {
  const owner = modelId.split("/", 1)[0] ?? "";
  const api = metadata.model.api;
  return typeof api === "string" && DOCUMENT_INPUT_APIS_BY_OWNER[owner]?.has(api) === true;
}

export function providerApiCanSerializeResponseFormat(metadata: ModelCapabilityMetadata): boolean {
  return (
    metadata.model.api === "openai-responses" ||
    metadata.model.api === "azure-openai-responses" ||
    metadata.model.api === "openai-completions" ||
    metadata.model.api === "anthropic-messages"
  );
}

export function isOpenAIResponsesApi(api: unknown): boolean {
  return (
    api === "openai-responses"
    || api === "openai-codex-responses"
    || api === "azure-openai-responses"
  );
}

export function modelSupportsReasoningConfigurationUpdate(
  metadata: ModelCapabilityMetadata
): boolean {
  return isRecord(metadata.model.compat)
    && metadata.model.compat.supportsReasoningConfigurationUpdate === true;
}

export function modelSupportsHostedWebSearch(metadata: ModelCapabilityMetadata): boolean {
  return (
    (metadata.model.provider === "openai" && metadata.model.api === "openai-responses")
    || (
      metadata.model.provider === "openai-codex"
      && metadata.model.api === "openai-codex-responses"
    )
    || metadata.model.api === "azure-openai-responses"
  );
}
