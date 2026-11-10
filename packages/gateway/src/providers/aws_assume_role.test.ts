import { expect, test } from "bun:test";

import {
  createAwsRoleCredentials,
  type AssumedRoleCredentials,
} from "./aws_assume_role.js";
import type { AwsAssumeRoleProviderAuth } from "../types.js";

const roleAuth: AwsAssumeRoleProviderAuth = {
  type: "aws_assume_role",
  role_arn: "arn:aws:iam::123456789012:role/dari-bedrock",
  external_id: "org_123",
  region: "us-east-1",
};

function issued(suffix: string, expiresAt: number): AssumedRoleCredentials {
  return {
    type: "aws_sigv4",
    access_key_id: `ASIA${suffix}`,
    secret_access_key: `secret-${suffix}`,
    session_token: `session-${suffix}`,
    region: "us-east-1",
    expires_at: expiresAt,
  };
}

test("passes bearer and SigV4 authentication through untouched", async () => {
  const credentials = createAwsRoleCredentials({
    assumeRole: () => Promise.reject(new Error("must not assume")),
  });
  const bearer = { type: "bearer" as const, apiKey: "key" };
  const sigv4 = {
    type: "aws_sigv4" as const,
    access_key_id: "AKIA",
    secret_access_key: "secret",
    region: "us-east-1",
  };
  expect(await credentials.resolve(bearer)).toBe(bearer);
  expect(await credentials.resolve(sigv4)).toBe(sigv4);
});

test("assumes the role once and reuses credentials until near expiry", async () => {
  let clock = 1_000_000;
  let calls = 0;
  const credentials = createAwsRoleCredentials({
    now: () => clock,
    assumeRole: async () => {
      calls += 1;
      return issued(String(calls), clock + 60 * 60_000);
    },
  });

  expect(await credentials.resolve(roleAuth)).toEqual({
    type: "aws_sigv4",
    access_key_id: "ASIA1",
    secret_access_key: "secret-1",
    session_token: "session-1",
    region: "us-east-1",
  });
  expect(credentials.secrets(roleAuth)).toEqual([
    "ASIA1",
    "secret-1",
    "session-1",
  ]);

  clock += 50 * 60_000;
  await credentials.resolve(roleAuth);
  expect(calls).toBe(1);

  // Inside the five-minute refresh margin: re-assume.
  clock += 6 * 60_000;
  const refreshed = await credentials.resolve(roleAuth);
  expect(calls).toBe(2);
  expect(refreshed.type === "aws_sigv4" && refreshed.access_key_id).toBe("ASIA2");

  // A stream that started before the refresh still signs with ASIA1, so both
  // sets stay scrubbable until the old one expires.
  expect(credentials.secrets(roleAuth)).toEqual([
    "ASIA2",
    "secret-2",
    "session-2",
    "ASIA1",
    "secret-1",
    "session-1",
  ]);
  clock += 5 * 60_000;
  expect(credentials.secrets(roleAuth)).toEqual(["ASIA2", "secret-2", "session-2"]);
});

test("caches per role, external ID, and region", async () => {
  const seen: string[] = [];
  const credentials = createAwsRoleCredentials({
    assumeRole: async (auth) => {
      seen.push(`${auth.role_arn}|${auth.external_id}|${auth.region}`);
      return issued(String(seen.length), Date.now() + 60 * 60_000);
    },
  });
  await credentials.resolve(roleAuth);
  await credentials.resolve({ ...roleAuth, external_id: "org_other" });
  await credentials.resolve({ ...roleAuth, region: "eu-west-1" });
  await credentials.resolve(roleAuth);
  expect(seen).toEqual([
    "arn:aws:iam::123456789012:role/dari-bedrock|org_123|us-east-1",
    "arn:aws:iam::123456789012:role/dari-bedrock|org_other|us-east-1",
    "arn:aws:iam::123456789012:role/dari-bedrock|org_123|eu-west-1",
  ]);
});

test("shares one in-flight AssumeRole call and retries after failure", async () => {
  let calls = 0;
  let fail = true;
  const credentials = createAwsRoleCredentials({
    assumeRole: async () => {
      calls += 1;
      await Promise.resolve();
      if (fail) throw new Error("AccessDenied");
      return issued(String(calls), Date.now() + 60 * 60_000);
    },
  });

  const attempts = await Promise.allSettled([
    credentials.resolve(roleAuth),
    credentials.resolve(roleAuth),
  ]);
  expect(attempts.map((attempt) => attempt.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(calls).toBe(1);
  expect(credentials.secrets(roleAuth)).toEqual([]);

  fail = false;
  const resolved = await credentials.resolve(roleAuth);
  expect(calls).toBe(2);
  expect(resolved.type).toBe("aws_sigv4");
});

test("the pinned STS client loads and builds an AssumeRole command under Bun", async () => {
  // The bundled Bedrock client pins @smithy/core; a mismatched client-sts
  // release throws at module load, which the fake assumeRole above never hits.
  const { AssumeRoleCommand, STSClient } = await import("@aws-sdk/client-sts");
  const client = new STSClient({
    region: "us-east-1",
    credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
  });
  const command = new AssumeRoleCommand({
    RoleArn: roleAuth.role_arn,
    ExternalId: roleAuth.external_id,
    RoleSessionName: "dari-routing",
  });
  expect(command.input.ExternalId).toBe("org_123");
  client.destroy();
});
