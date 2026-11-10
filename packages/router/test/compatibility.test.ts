import { expect, test } from "bun:test";

import { resolveCompatibleCandidates, type CandidateModelMetadata } from "../src/compatibility.js";
import { RouterCoreError } from "../src/errors.js";

test("omitted reasoning exposes every enabled model/thinking-level pair", () => {
  const compatible = resolveCompatibleCandidates({
    requiredCapabilities: [],
    candidateModels: ["openai/gpt-4.1-mini", "openai/gpt-5.5"],
    metadataLookup: metadataLookup({
      "openai/gpt-4.1-mini": metadata(["off"]),
      "openai/gpt-5.5": metadata(["off", "medium", "high"]),
    }),
    modelThinkingLevels: {
      "openai/gpt-4.1-mini": ["off"],
      "openai/gpt-5.5": ["medium", "high"],
    },
  });

  expect(compatible.candidates).toEqual([
    { model: "openai/gpt-4.1-mini", reasoningEffort: "off" },
    { model: "openai/gpt-5.5", reasoningEffort: "medium" },
    { model: "openai/gpt-5.5", reasoningEffort: "high" },
  ]);
});

test("reasoning configuration updates route only to models that support them", () => {
  const compatible = resolveCompatibleCandidates({
    requestedReasoningEffort: "high",
    requiredCapabilities: ["reasoning_configuration_update"],
    candidateModels: ["openai/gpt-5.6-sol", "openai/gpt-6-sol"],
    metadataLookup: metadataLookup({
      "openai/gpt-5.6-sol": metadata(["low", "high"]),
      "openai/gpt-6-sol": metadata(["low", "high"], {
        supportsReasoningConfigurationUpdate: true,
      }),
    }),
  });

  expect(compatible.candidates).toEqual([
    { model: "openai/gpt-6-sol", reasoningEffort: "high" },
  ]);
});

test("explicit reasoning effort is a hard candidate constraint", () => {
  const compatible = resolveCompatibleCandidates({
    requestedReasoningEffort: "high",
    requiredCapabilities: [],
    candidateModels: ["openai/gpt-4.1-mini", "openai/gpt-5.5"],
    metadataLookup: metadataLookup({
      "openai/gpt-4.1-mini": metadata(["off"]),
      "openai/gpt-5.5": metadata(["off", "medium", "high"]),
    }),
  });

  expect(compatible.candidates).toEqual([
    { model: "openai/gpt-5.5", reasoningEffort: "high" },
  ]);
});

test("router-enabled levels narrow model catalog support", () => {
  const compatible = resolveCompatibleCandidates({
    requiredCapabilities: [],
    candidateModels: ["openai/gpt-5.5"],
    metadataLookup: metadataLookup({
      "openai/gpt-5.5": metadata(["off", "low", "medium", "high"]),
    }),
    modelThinkingLevels: { "openai/gpt-5.5": ["low", "high"] },
  });

  expect(compatible.candidates).toEqual([
    { model: "openai/gpt-5.5", reasoningEffort: "low" },
    { model: "openai/gpt-5.5", reasoningEffort: "high" },
  ]);
});

test("router config cannot expose a level unsupported by provider metadata", () => {
  const compatible = resolveCompatibleCandidates({
    requiredCapabilities: [],
    candidateModels: ["custom/model"],
    metadataLookup: metadataLookup({
      "custom/model": metadata(["off", "medium"]),
    }),
    modelThinkingLevels: {
      "custom/model": ["off", "low", "medium", "high"],
    },
  });

  expect(compatible.candidates).toEqual([
    { model: "custom/model", reasoningEffort: "off" },
    { model: "custom/model", reasoningEffort: "medium" },
  ]);
});

test("fails before routing when no pair satisfies explicit reasoning", () => {
  expect(() =>
    resolveCompatibleCandidates({
      requestedReasoningEffort: "high",
      requiredCapabilities: [],
      candidateModels: ["openai/gpt-4.1-mini"],
      metadataLookup: metadataLookup({
        "openai/gpt-4.1-mini": metadata(["off"]),
      }),
    })
  ).toThrow(RouterCoreError);
});

test("thinking-enabled requests fail instead of silently selecting an off-only pair", () => {
  expect(() =>
    resolveCompatibleCandidates({
      thinkingEnabled: true,
      requiredCapabilities: [],
      candidateModels: ["anthropic/claude-sonnet-4-6"],
      metadataLookup: metadataLookup({
        "anthropic/claude-sonnet-4-6": metadata(["off"], {
          api: "anthropic-messages",
        }),
      }),
    })
  ).toThrow("Thinking is enabled, but no enabled non-off model/thinking-level pair");
});

test("forced tool choice removes non-off Anthropic pairs but keeps off", () => {
  const compatible = resolveCompatibleCandidates({
    toolChoice: "required",
    requiredCapabilities: [],
    candidateModels: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"],
    metadataLookup: metadataLookup({
      "anthropic/claude-sonnet-4-6": metadata(
        ["off", "medium", "high"],
        { api: "anthropic-messages" },
      ),
      "openai/gpt-5.5": metadata(
        ["off", "medium"],
        { api: "openai-responses" },
      ),
    }),
  });

  expect(compatible.candidates).toEqual([
    { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "off" },
    { model: "openai/gpt-5.5", reasoningEffort: "off" },
    { model: "openai/gpt-5.5", reasoningEffort: "medium" },
  ]);
});

test("fails when only non-off Anthropic pairs can serve forced tool choice", () => {
  expect(() =>
    resolveCompatibleCandidates({
      toolChoice: { kind: "function", name: "read_file" },
      requiredCapabilities: [],
      candidateModels: ["anthropic/claude-sonnet-4-6"],
      metadataLookup: metadataLookup({
        "anthropic/claude-sonnet-4-6": metadata(
          ["medium", "high"],
          { api: "anthropic-messages" },
        ),
      }),
    })
  ).toThrow("Forced tool choice is not supported");
});

test("keeps Meta candidates for automatic tool choice", () => {
  const compatible = resolveCompatibleCandidates({
    toolChoice: "auto",
    requiredCapabilities: [],
    candidateModels: ["meta/muse-spark-1.1"],
    metadataLookup: metadataLookup({
      "meta/muse-spark-1.1": metadata(
        ["minimal", "medium"],
        { provider: "meta", api: "openai-completions" },
      ),
    }),
  });

  expect(compatible.candidates).toEqual([
    { model: "meta/muse-spark-1.1", reasoningEffort: "minimal" },
    { model: "meta/muse-spark-1.1", reasoningEffort: "medium" },
  ]);
});

test("filters Meta candidates when another model can serve forced tool choice", () => {
  const compatible = resolveCompatibleCandidates({
    toolChoice: "required",
    requiredCapabilities: [],
    candidateModels: ["meta/muse-spark-1.1", "openai/gpt-5.5"],
    metadataLookup: metadataLookup({
      "meta/muse-spark-1.1": metadata(["minimal"], {
        provider: "meta",
        api: "openai-completions",
      }),
      "openai/gpt-5.5": metadata(["medium"], {
        provider: "openai",
        api: "openai-responses",
      }),
    }),
  });

  expect(compatible.candidates).toEqual([
    { model: "openai/gpt-5.5", reasoningEffort: "medium" },
  ]);
});

test("fails clearly when a Meta-only router receives named tool choice", () => {
  expect(() =>
    resolveCompatibleCandidates({
      toolChoice: { kind: "function", name: "echo" },
      requiredCapabilities: [],
      candidateModels: ["meta/muse-spark-1.1"],
      metadataLookup: metadataLookup({
        "meta/muse-spark-1.1": metadata(["minimal"], {
          provider: "meta",
          api: "openai-completions",
        }),
      }),
    })
  ).toThrow("Meta models currently support only omitted or 'auto' tool_choice");
});

test("preserves the forced-tool error when Meta and Anthropic both reject", () => {
  expect(() =>
    resolveCompatibleCandidates({
      toolChoice: { kind: "function", name: "echo" },
      requiredCapabilities: [],
      candidateModels: ["meta/muse-spark-1.1", "anthropic/claude-sonnet-4-6"],
      metadataLookup: metadataLookup({
        "meta/muse-spark-1.1": metadata(["minimal"], {
          provider: "meta",
          api: "openai-completions",
        }),
        "anthropic/claude-sonnet-4-6": metadata(["medium"], {
          provider: "anthropic",
          api: "anthropic-messages",
        }),
      }),
    })
  ).toThrow("Forced tool choice is not supported");
});

test("filters text-only candidates when image input is required", () => {
  const compatible = resolveCompatibleCandidates({
    requiredCapabilities: ["image_input"],
    candidateModels: ["openai/gpt-5.5", "fireworks/deepseek-v4"],
    metadataLookup: metadataLookup({
      "openai/gpt-5.5": metadata(["off", "medium"], { supportsImageInput: true }),
      "fireworks/deepseek-v4": metadata(["off", "medium"], { supportsImageInput: false }),
    }),
  });

  expect(compatible.candidates).toEqual([
    { model: "openai/gpt-5.5", reasoningEffort: "off" },
    { model: "openai/gpt-5.5", reasoningEffort: "medium" },
  ]);
});

test("fails before selection when no enabled model accepts image input", () => {
  expect(() =>
    resolveCompatibleCandidates({
      requiredCapabilities: ["image_input"],
      candidateModels: ["fireworks/deepseek-v4"],
      metadataLookup: metadataLookup({
        "fireworks/deepseek-v4": metadata(["off", "medium"], { supportsImageInput: false }),
      }),
    })
  ).toThrow("Image input is not supported by any enabled model");
});

test("filters provider APIs that cannot carry structured output", () => {
  const compatible = resolveCompatibleCandidates({
    requiredCapabilities: ["structured_output"],
    candidateModels: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"],
    metadataLookup: metadataLookup({
      "anthropic/claude-sonnet-4-6": metadata(["medium"], {
        api: "anthropic-messages",
        supportsStructuredOutput: false,
      }),
      "openai/gpt-5.5": metadata(["off", "medium"], {
        api: "openai-responses",
      }),
    }),
  });

  expect(compatible.candidates).toEqual([
    { model: "openai/gpt-5.5", reasoningEffort: "off" },
    { model: "openai/gpt-5.5", reasoningEffort: "medium" },
  ]);
});

test("hosted web search keeps only host-approved Responses candidates", () => {
  const compatible = resolveCompatibleCandidates({
    requiredCapabilities: ["openai_hosted_web_search"],
    candidateModels: [
      "fireworks/deepseek-v4",
      "openai/gpt-5.5",
      "openai/gpt-5.6-sol",
      "azure/gpt-5.5",
    ],
    metadataLookup: metadataLookup({
      "fireworks/deepseek-v4": metadata(["off"]),
      "openai/gpt-5.5": metadata(["off", "medium"], { supportsHostedWebSearch: true }),
      "openai/gpt-5.6-sol": metadata(["off", "high"], { supportsHostedWebSearch: true }),
      "azure/gpt-5.5": metadata(["off", "medium"], { supportsHostedWebSearch: true }),
    }),
  });

  expect(compatible.candidates).toEqual([
    { model: "openai/gpt-5.5", reasoningEffort: "off" },
    { model: "openai/gpt-5.5", reasoningEffort: "medium" },
    { model: "openai/gpt-5.6-sol", reasoningEffort: "off" },
    { model: "openai/gpt-5.6-sol", reasoningEffort: "high" },
    { model: "azure/gpt-5.5", reasoningEffort: "off" },
    { model: "azure/gpt-5.5", reasoningEffort: "medium" },
  ]);
});

test("hosted web search fails before selection without an approved candidate", () => {
  expect(() =>
    resolveCompatibleCandidates({
      requiredCapabilities: ["openai_hosted_web_search"],
      candidateModels: ["fireworks/deepseek-v4"],
      metadataLookup: metadataLookup({
        "fireworks/deepseek-v4": metadata(["off"]),
      }),
    })
  ).toThrow("Hosted web search requires an enabled OpenAI or Azure Responses model");
});

function metadataLookup(entries: Record<string, CandidateModelMetadata>) {
  return (modelId: string) =>
    entries[modelId] ??
    metadata(["off", "minimal", "low", "medium", "high", "xhigh"]);
}

function metadata(
  supportedThinkingLevels: string[],
  overrides: Partial<CandidateModelMetadata> = {},
): CandidateModelMetadata {
  return {
    provider: "openai",
    api: "openai-responses",
    supportsImageInput: true,
    supportsHostedWebSearch: false,
    supportsStructuredOutput: overrides.api === "anthropic-messages" ? false : true,
    supportedThinkingLevels,
    ...overrides,
  };
}
