#!/usr/bin/env bun
// Copies the canonical models from the monorepo's router model catalog into
// src/models/canonical_models.json, the list the local model picker shows:
// each model's id, display name, maker, its default provider's thinking
// levels, and the providers whose API keys serve it when a router spec names
// none.
// Also writes src/models/provider_models.json: each other provider or gateway
// a self-hosted gateway can serve a model through (a router spec's
// `provider`), with the model's id, API, and endpoint there.
// Run from the monorepo, where dari-backend/config is present.
import { join, resolve } from "node:path";

import { gatewayFor } from "../src/models/gateways.ts";

type CatalogModel = { id: string; display_name: string; default_provider: string };
type ProviderMapping = {
  model_id: string;
  provider: string;
  native_model_id: string;
  api: string;
  base_url?: string | null;
  supported_thinking_levels?: string[];
};
type GatewayMapping = { model_id: string; gateway: string; native_model_id: string };

// Their endpoints and credentials come from a cloud account, which a
// self-hosted gateway has no setting for.
const CLOUD_ACCOUNT_PROVIDERS = new Set(["azure", "amazon-bedrock"]);

const root = resolve(import.meta.dir, "..");
const config = join(root, "../../../dari-backend/config");
const catalog = await Bun.file(join(config, "router-model-catalog.json")).json() as {
  makers: Record<string, string>;
  models: CatalogModel[];
};
const mappings = await Bun.file(join(config, "provider-model-mappings.json")).json() as {
  provider_model_mappings: ProviderMapping[];
};
const gatewayMappings = await Bun.file(join(config, "gateway-model-mappings.json")).json() as {
  gateway_model_mappings: GatewayMapping[];
};

// A model's own provider (the id's prefix) serves it without a mapping.
// Every gateway speaks OpenAI chat completions at its own endpoint.
const catalogIds = new Set(catalog.models.map((model) => model.id));
const providerModels = [
  ...mappings.provider_model_mappings
    .filter((row) => row.provider !== row.model_id.split("/")[0] && !CLOUD_ACCOUNT_PROVIDERS.has(row.provider))
    .map((row) => ({
      model_id: row.model_id,
      provider: row.provider,
      native_model_id: row.native_model_id,
      api: row.api,
      base_url: row.base_url ?? null,
    })),
  ...gatewayMappings.gateway_model_mappings.map((row) => {
    const gateway = gatewayFor(row.gateway);
    if (gateway === undefined) throw new Error(`${row.model_id} maps to unknown gateway ${row.gateway}`);
    return {
      model_id: row.model_id,
      provider: row.gateway,
      native_model_id: row.native_model_id,
      api: "openai-completions",
      base_url: gateway.baseUrl,
    };
  }),
].filter((row) => catalogIds.has(row.model_id));

const models = catalog.models.map((model) => {
  const mapping = mappings.provider_model_mappings.find(
    (row) => row.model_id === model.id && row.provider === model.default_provider,
  );
  if (mapping === undefined) throw new Error(`${model.id} has no ${model.default_provider} mapping`);
  const maker = catalog.makers[model.id.split("/")[0]!];
  if (maker === undefined) throw new Error(`${model.id} has no maker`);
  // A model its own provider serves stays with that provider's key. One it
  // does not, such as an open-weights model, is served by every provider
  // that runs it, its default first.
  const own = model.id.split("/")[0]!;
  const others = providerModels
    .filter((row) => row.model_id === model.id && row.provider !== model.default_provider)
    .map((row) => row.provider);
  return {
    id: model.id,
    name: model.display_name,
    maker,
    thinking_levels: mapping.supported_thinking_levels ?? [],
    providers: model.default_provider === own ? [own] : [model.default_provider, ...others],
  };
});
await Bun.write(join(root, "src/models/canonical_models.json"), `${JSON.stringify(models, null, 2)}\n`);
console.log(`wrote ${models.length} canonical models`);
await Bun.write(join(root, "src/models/provider_models.json"), `${JSON.stringify(providerModels, null, 2)}\n`);
console.log(`wrote ${providerModels.length} provider models`);
