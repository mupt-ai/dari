import type { Harness } from "./index.js";

// Sends nothing of its own that tells it apart, so the Dari CLI sets it up to
// name itself in x-dari-client-harness.
export const openclaw = {
  id: "openclaw",
  headers: [],
} as const satisfies Harness;
