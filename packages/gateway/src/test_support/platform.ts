import { bindGatewayPlatform, type GatewayPlatform } from "../platform/platform.js";

/**
 * A platform for unit tests: state writes and reporting are accepted and
 * dropped, error capture is silent, and router resolution or managed usage
 * fail loudly unless the test supplies them.
 */
export function testPlatform(overrides: Partial<GatewayPlatform> = {}): GatewayPlatform {
  return {
    async resolveRouter() {
      throw new Error("Unexpected router resolution in a unit test.");
    },
    async writePrefixState() {},
    async writePendingLease() {},
    async readSessionPin() {
      return null;
    },
    async writeSessionPin() {},
    async markSubscriptionUnavailable() {
      return false;
    },
    async recordUsage() {
      throw new Error("Unexpected managed usage in a unit test.");
    },
    recordRequest() {},
    captureRequestError() {},
    captureOperationalError() {},
    ...overrides,
  };
}

/** Bind a test platform for the rest of the test file. */
export function bindTestPlatform(overrides: Partial<GatewayPlatform> = {}): GatewayPlatform {
  const platform = testPlatform(overrides);
  bindGatewayPlatform(platform);
  return platform;
}
