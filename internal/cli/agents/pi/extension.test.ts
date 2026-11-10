import { expect, test } from "bun:test";
import extension from "./extension";

for (const outcome of ["session_compact", "session_compact_failed"]) {
  test(`Pi tags compaction until ${outcome}, then returns to main turns`, async () => {
    const handlers = new Map<string, Function>();
    extension({
      registerProvider() {},
      on(name: string, handler: Function) { handlers.set(name, handler); },
    });
    let sessionId = "session-one";
    const ctx = {
      model: { provider: "dari" },
      sessionManager: { getSessionId: () => sessionId },
    };
    const emit = async (name: string, event = {}) => handlers.get(name)?.(event, ctx);
    const headers = async () => {
      const event = { headers: { "x-session-affinity": "provider-cache-key" } };
      await emit("before_provider_headers", event);
      return event.headers;
    };
    expect(await headers()).toMatchObject({
      "x-pi-session-id": "session-one",
      "x-pi-request-kind": "turn",
      "x-session-affinity": "provider-cache-key",
    });
    await emit("session_before_compact");
    // Split-turn summaries and retries must all remain compaction requests.
    for (let i = 0; i < 2; i++) {
      expect(await headers()).toMatchObject({ "x-pi-request-kind": "compaction" });
    }
    await emit(outcome);
    expect(await headers()).toMatchObject({ "x-pi-request-kind": "turn" });
    sessionId = "session-two";
    expect(await headers()).toMatchObject({ "x-pi-session-id": "session-two" });
    ctx.model.provider = "other";
    expect(await headers()).toEqual({ "x-session-affinity": "provider-cache-key" });
  });
}
