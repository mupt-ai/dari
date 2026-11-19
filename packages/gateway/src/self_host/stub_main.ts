#!/usr/bin/env bun
/**
 * The stub gateway as a process, for test runners that are not Bun:
 *
 * ```sh
 * dari-gateway-stub --plans openai_codex,anthropic_claude_code
 * ```
 *
 * It prints one JSON line, `{"baseUrl", "gatewayKey", "planIds", "keyIds",
 * "userCookie", "controlUrl", "app"}`, then serves until it is killed. The plans are the approval
 * page's user's: `userCookie` is the `Cookie` header that opens the page as them. `app` is a server
 * app registered on the gateway (`gatewayUrl`, `clientId`, `clientSecret`, `redirectUri`), and
 * `POST <controlUrl>/connect` (with `{"credential_ids"?, "deny"?, "clients"?, "plans"?,
 * "key_providers"?, "grant_id"?}`, all optional) is its user approving it: it answers
 * `{"code", "code_verifier", "state"}`, what Connect with Dari hands your page. `GET <controlUrl>/served`
 * answers `{"calls": [...]}`: every provider call so far, with its path,
 * model, thinking, and client headers. For an app you registered yourself, `POST <controlUrl>/approve` with
 * `{"url": <authorize URL>, "credential_ids"?, "deny"?}` goes through the
 * approval page and answers `{"message", "target_origin"}`, which `GET
 * <controlUrl>/messages` lists; `POST <controlUrl>/state` with `{"limited"?,
 * "five_hour"?, "weekly"?}` forces plan error states (see stub_gateway.ts).
 * Options: `--plans` (comma-separated
 * `openai_codex` and `anthropic_claude_code`), `--keys` (comma-separated
 * `anthropic`, `openai`, and `openrouter`: an API key of the plans' user for each), `--models` (the default
 * router's models), `--key` (the gateway key), `--port` (the gateway's port),
 * `--redirect-uri` (the redirect URI `app` is registered with),
 * and `--allow-http-redirect-host` (repeatable: a host apps may register http
 * redirect URIs on, such as `*.example.ts.net`).
 */
import { startStubGateway, type StubGatewayOptions } from "./stub_gateway.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

const list = (value: string | undefined) => value?.split(",").map((item) => item.trim()).filter(Boolean);

const plans = list(option("plans"));
if (plans?.some((plan) => plan !== "openai_codex" && plan !== "anthropic_claude_code")) {
  console.error("--plans takes openai_codex and anthropic_claude_code, comma-separated.");
  process.exit(2);
}
const keys = list(option("keys"));
if (keys?.some((key) => key !== "anthropic" && key !== "openai" && key !== "openrouter")) {
  console.error("--keys takes anthropic, openai, and openrouter, comma-separated.");
  process.exit(2);
}
const models = list(option("models"));
const gatewayKey = option("key");
const port = option("port");
if (port !== undefined && !/^\d+$/.test(port)) {
  console.error("--port takes a port number.");
  process.exit(2);
}
const redirectUri = option("redirect-uri");
const httpHosts = process.argv.flatMap((arg, index) => arg === "--allow-http-redirect-host" ? [process.argv[index + 1] ?? ""] : []);
const gateway = await startStubGateway({
  ...(plans ? { plans: plans as NonNullable<StubGatewayOptions["plans"]> } : {}),
  ...(keys ? { keys: keys as NonNullable<StubGatewayOptions["keys"]> } : {}),
  ...(models ? { models } : {}),
  ...(gatewayKey ? { gatewayKey } : {}),
  ...(port ? { port: Number(port) } : {}),
  ...(redirectUri ? { redirectUri } : {}),
  ...(httpHosts.length > 0 ? { allowHttpRedirectHosts: httpHosts } : {}),
});
console.log(JSON.stringify({
  baseUrl: gateway.baseUrl,
  gatewayKey: gateway.gatewayKey,
  planIds: gateway.planIds,
  keyIds: gateway.keyIds,
  userCookie: gateway.userCookie,
  controlUrl: gateway.controlUrl,
  app: gateway.app,
}));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void gateway.stop().then(() => process.exit(0));
  });
}
