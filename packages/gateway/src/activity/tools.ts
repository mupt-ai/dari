/* Tool and skill Activity routes: `tools-skills`, its inventory, and one
   item's detail. */

import { readActivityQuery, readSourceScope, sourceProtocols, validatedBucketFilters, validatedFilters } from "./filters.js";
import type { ActivityRoute } from "./http.js";
import { badRequest, notFound } from "./params.js";
import {
  MAX_SELECTED_SERIES,
  toolSkillActivity,
  toolSkillDetail as loadDetail,
  toolSkillInventory as loadInventory,
  type ToolSkillMode,
} from "./tool_skill_activity.js";

const MODES = ["tools", "skills"] as const;
const INVENTORY_MAX_LIMIT = 100;

export const toolSkills: ActivityRoute = async ({ db, params, admitted }) => {
  params.requirePresent("mode");
  const mode: ToolSkillMode = params.literal("mode", MODES) ?? "tools";
  const bucketSeconds = params.int("bucket_seconds", { ge: 60 });
  const scope = readSourceScope(params);
  const metric = params.literal("series_metric", ["uses", "file_reads", "activity"] as const, "uses");
  const seriesIds = params.strings("series_id");
  const query = readActivityQuery(params);
  params.done();
  const protocols = sourceProtocols(scope);
  const organizationId = admitted();
  const filters = validatedBucketFilters(query, protocols, bucketSeconds);
  if (mode === "tools" && metric !== "uses") throw badRequest("Tool series can only be ranked by uses.");
  const ids = [...new Set(seriesIds)];
  if (ids.length > MAX_SELECTED_SERIES) throw badRequest(`Select at most ${MAX_SELECTED_SERIES} tool or skill series.`);
  if (ids.some((id) => !id || id.length > 512)) throw badRequest("Tool or skill series IDs must contain 1 to 512 characters.");
  return toolSkillActivity({ db, organizationId, filters, mode }, metric, ids);
};

export const toolSkillInventory: ActivityRoute = async ({ db, params, admitted }) => {
  params.requirePresent("mode");
  const mode: ToolSkillMode = params.literal("mode", MODES) ?? "tools";
  const scope = readSourceScope(params);
  const search = params.string("search", { maxLength: 200 }) ?? "";
  const sortBy = params.literal("sort_by", ["name", "uses", "file_reads", "latest"] as const, "uses");
  const sortDirection = params.literal("sort_direction", ["asc", "desc"] as const, "desc");
  const limit = params.int("limit", { default: 20, ge: 1, le: INVENTORY_MAX_LIMIT });
  const offset = params.int("offset", { default: 0, ge: 0 });
  const query = readActivityQuery(params);
  params.done();
  const protocols = sourceProtocols(scope);
  const organizationId = admitted();
  const filters = validatedFilters(query, protocols);
  return loadInventory({ db, organizationId, filters, mode }, {
    // Python's str.strip(): Unicode whitespace, like JavaScript's trim().
    search: search.trim(),
    sortBy,
    sortDirection,
    limit,
    offset,
  });
};

export const toolSkillDetail: ActivityRoute = async ({ db, params, admitted }) => {
  params.requirePresent("mode");
  const mode: ToolSkillMode = params.literal("mode", MODES) ?? "tools";
  params.requirePresent("capability_id");
  const capabilityId = params.string("capability_id", { minLength: 1, maxLength: 512 }) ?? "";
  const bucketSeconds = params.int("bucket_seconds", { ge: 60 });
  const scope = readSourceScope(params);
  const query = readActivityQuery(params);
  params.done();
  const protocols = sourceProtocols(scope);
  const organizationId = admitted();
  const filters = validatedBucketFilters(query, protocols, bucketSeconds);
  const detail = await loadDetail({ db, organizationId, filters, mode }, capabilityId);
  if (detail === null) throw notFound("Tool or skill activity not found.");
  return detail;
};
