import { expect, test } from "bun:test";

import type {
  AwsAssumeRoleProviderAuth,
  AwsProviderAuth,
  AwsSigV4ProviderAuth,
} from "../types.js";
import { providerAuthForSelectedModel } from "./routing.js";

test("requires stored provider authentication for the selected model", () => {
  expect(
    providerAuthForSelectedModel({
      selectedModel: "deepseek-ai/DeepSeek-V4-Pro-0813",
      credentials: credentials(
        "deepseek-ai/DeepSeek-V4-Pro-0813",
        { fireworks: " sk-fireworks " },
        { fireworks: "managed" },
      ),
    }),
  ).toEqual({ type: "bearer", apiKey: "sk-fireworks" });
  expect(
    providerAuthForSelectedModel({
      selectedModel: "zai-org/GLM-5.2",
      credentials: credentials(
        "zai-org/GLM-5.2",
        { fireworks: " sk-fireworks " },
        { fireworks: "managed" },
      ),
    }),
  ).toEqual({ type: "bearer", apiKey: "sk-fireworks" });
  expect(() =>
    providerAuthForSelectedModel({
      selectedModel: "anthropic/claude-sonnet-4-6",
      credentials: credentials(
        "anthropic/claude-sonnet-4-6",
        { openai: "sk-openai" },
      ),
    }),
  ).toThrow("No stored Anthropic provider credential is configured for this router.");
  expect(() =>
    providerAuthForSelectedModel({
      selectedModel: "openai/gpt-4.1-mini",
      credentials: credentials(
        "openai/gpt-4.1-mini",
        {},
        { openai: "managed" },
      ),
    }),
  ).toThrow("No Dari-managed OpenAI provider credential is configured for this router.");
});

test("uses request-scoped SigV4 authentication for Amazon Bedrock", () => {
  const auth: AwsSigV4ProviderAuth = {
    type: "aws_sigv4",
    access_key_id: "AKIAEXAMPLE",
    secret_access_key: "secret",
    session_token: "session",
    region: "us-east-1",
  };
  const bedrockCredentials = credentials(
    "anthropic/claude-sonnet-4-6",
    {},
    { "amazon-bedrock": "user" },
    { "amazon-bedrock": auth },
    "amazon-bedrock",
  );
  expect(
    providerAuthForSelectedModel({
      selectedModel: "anthropic/claude-sonnet-4-6",
      credentials: bedrockCredentials,
    }),
  ).toEqual(auth);
  expect(() =>
    providerAuthForSelectedModel({
      selectedModel: "anthropic/claude-sonnet-4-6",
      credentials: {
        ...bedrockCredentials,
        provider_keys: { "amazon-bedrock": "ambiguous-bearer-token" },
      },
    }),
  ).toThrow("Invalid Amazon Bedrock provider authentication");
});

test("uses AssumeRole authentication for Amazon Bedrock", () => {
  const auth: AwsAssumeRoleProviderAuth = {
    type: "aws_assume_role",
    role_arn: "arn:aws:iam::123456789012:role/dari-bedrock",
    external_id: "org_123",
    region: "us-east-1",
  };
  const bedrockCredentials = credentials(
    "anthropic/claude-sonnet-4-6",
    {},
    { "amazon-bedrock": "user" },
    { "amazon-bedrock": auth },
    "amazon-bedrock",
  );
  expect(
    providerAuthForSelectedModel({
      selectedModel: "anthropic/claude-sonnet-4-6",
      credentials: bedrockCredentials,
    }),
  ).toEqual(auth);
  expect(() =>
    providerAuthForSelectedModel({
      selectedModel: "anthropic/claude-sonnet-4-6",
      credentials: {
        ...bedrockCredentials,
        provider_auth: {
          "amazon-bedrock": { ...auth, external_id: " " },
        },
      },
    }),
  ).toThrow("Invalid Amazon Bedrock provider authentication");
});

test("uses SigV4 authentication for a custom provider on the Bedrock API", () => {
  const auth: AwsSigV4ProviderAuth = {
    type: "aws_sigv4",
    access_key_id: "AKIAEXAMPLE",
    secret_access_key: "secret",
    session_token: "session",
    region: "us-east-1",
  };
  const selectedModel = "prox-bedrock/gpt-5.6-sol";
  const proxBedrock = credentials(
    selectedModel,
    {},
    { "prox-bedrock": "user" },
    { "prox-bedrock": auth },
    "prox-bedrock",
  );
  proxBedrock.model_configs[selectedModel].api = "bedrock-converse-stream";
  proxBedrock.model_configs[selectedModel].native_model_id = "us.openai.gpt-5.6-sol";

  expect(providerAuthForSelectedModel({
    selectedModel,
    credentials: proxBedrock,
  })).toEqual(auth);

  proxBedrock.model_configs[selectedModel].api = "openai-completions";
  expect(() => providerAuthForSelectedModel({
    selectedModel,
    credentials: proxBedrock,
  })).toThrow("Invalid Prox Bedrock provider authentication");
});

function credentials(
  model: string,
  providerKeys: Record<string, string>,
  providerKeySources?: Record<string, "managed" | "user">,
  providerAuth?: Record<string, AwsProviderAuth>,
  executionProvider?: string,
) {
  return {
    router_id: "rtr_1",
    organization_id: "org_1",
    api_key_id: null,
    attributed_user_id: null,
    enabled_models: [model],
    provider_keys: providerKeys,
    ...(providerAuth === undefined ? {} : { provider_auth: providerAuth }),
    model_configs: {
      [model]: {
        provider: executionProvider ?? (
          model === "zai-org/GLM-5.2" || model.startsWith("deepseek-ai/")
            ? "fireworks"
            : model.slice(0, model.indexOf("/"))
        ),
        native_model_id: model,
        api: "openai-completions",
        cost: { input: 0, output: 0 },
      },
    },
    ...(providerKeySources === undefined
      ? {}
      : { provider_key_sources: providerKeySources }),
  };
}
