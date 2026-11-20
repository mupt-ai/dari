/* Every Activity route, by its path under `/routing/activity/`: a read,
   unless it names another method. */

import { filterOptions, models, overview, routers, series } from "./core.js";
import { conversation, conversations, payload, toolExchanges } from "./conversations.js";
import type { ActivityRoute } from "./http.js";
import { importSession } from "./imports.js";
import { peopleKeys, peopleSeries } from "./people.js";
import { pullRequest, pullRequests } from "./pull_requests.js";
import { toolSkillDetail, toolSkillInventory, toolSkills } from "./tools.js";

export const ACTIVITY_ROUTES: ReadonlyArray<readonly [string, ActivityRoute, method?: "POST"]> = [
  ["filter-options", filterOptions],
  ["overview", overview],
  ["series", series],
  ["routers", routers],
  ["models", models],
  ["people-keys", peopleKeys],
  ["people-series", peopleSeries],
  ["conversations", conversations],
  ["conversations/:conversation_ref", conversation],
  ["requests/:request_id/client-request", payload("client_request")],
  ["requests/:request_id/selector-output", payload("selector_output")],
  ["requests/:request_id/client-response", payload("client_response")],
  ["tool-exchanges", toolExchanges],
  ["tools-skills", toolSkills],
  ["tools-skills/detail", toolSkillDetail],
  ["tools-skills/inventory", toolSkillInventory],
  ["imports", importSession, "POST"],
  ["pull-requests", pullRequests],
  ["pull-requests/:owner/:repo/:number", pullRequest],
];
