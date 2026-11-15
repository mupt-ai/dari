import { expect, test } from "bun:test";

import { parseGatewayConfig } from "./config.js";

test("link.allowHttpRedirectHosts lists dev hosts, and nothing else is allowed by default", () => {
  const routers = { default: { models: ["openai/gpt-5.5"] } };
  expect(parseGatewayConfig({ routers }).link).toBeUndefined();
  expect(parseGatewayConfig({ routers, link: { allowHttpRedirectHosts: ["*.Example.ts.net", "dev.local"] } }).link)
    .toEqual({ allowHttpRedirectHosts: ["*.example.ts.net", "dev.local"] });
  expect(() => parseGatewayConfig({ routers, link: { allowHttpRedirectHosts: ["http://dev.local"] } })).toThrow("allowHttpRedirectHosts");
  expect(() => parseGatewayConfig({ routers, link: { allowHttpRedirectHosts: ["*"] } })).toThrow("allowHttpRedirectHosts");
});
