#!/usr/bin/env bun
// Copies the canonical model ids from the monorepo's router model catalog into
// src/models/canonical_model_ids.json, the list the local model picker shows.
// Run from the monorepo, where dari-backend/config is present.
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = join(root, "../../../dari-backend/config/router-model-catalog.json");
const catalog = await Bun.file(source).json() as { models: { id: string }[] };
const ids = catalog.models.map((model) => model.id);
await Bun.write(join(root, "src/models/canonical_model_ids.json"), `${JSON.stringify(ids, null, 2)}\n`);
console.log(`wrote ${ids.length} canonical model ids`);
