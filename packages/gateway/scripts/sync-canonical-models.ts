#!/usr/bin/env bun
// Copies the canonical models from the monorepo's router model catalog into
// src/models/canonical_models.json, the list the local model picker shows:
// each model's id, display name, and its default provider's thinking levels.
// Run from the monorepo, where dari-backend/config is present.
import { join, resolve } from "node:path";

type CatalogModel = { id: string; display_name: string; default_provider: string };
type ProviderMapping = { model_id: string; provider: string; supported_thinking_levels?: string[] };

const root = resolve(import.meta.dir, "..");
const config = join(root, "../../../dari-backend/config");
const catalog = await Bun.file(join(config, "router-model-catalog.json")).json() as { models: CatalogModel[] };
const mappings = await Bun.file(join(config, "provider-model-mappings.json")).json() as {
  provider_model_mappings: ProviderMapping[];
};
const models = catalog.models.map((model) => {
  const mapping = mappings.provider_model_mappings.find(
    (row) => row.model_id === model.id && row.provider === model.default_provider,
  );
  if (mapping === undefined) throw new Error(`${model.id} has no ${model.default_provider} mapping`);
  return { id: model.id, name: model.display_name, thinking_levels: mapping.supported_thinking_levels ?? [] };
});
await Bun.write(join(root, "src/models/canonical_models.json"), `${JSON.stringify(models, null, 2)}\n`);
console.log(`wrote ${models.length} canonical models`);
