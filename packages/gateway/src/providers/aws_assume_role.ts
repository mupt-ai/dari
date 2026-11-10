import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

import { HttpError } from "../http/errors.js";
import type {
  AwsAssumeRoleProviderAuth,
  AwsSigV4ProviderAuth,
  ProviderAuth,
  ResolvedProviderAuth,
} from "../types.js";

const ROLE_SESSION_NAME = "dari-routing";
// AssumeRole always goes through this regional STS endpoint. The customer's
// Bedrock region may be an opt-in region Dari's own account has not enabled,
// where a regional STS call would fail. Regional endpoints issue v2 tokens
// that are valid in every region, so the temporary credentials still sign
// Bedrock requests in the customer's region.
const STS_REGION = "us-east-1";
// Re-assume the role this long before the temporary credentials expire so a
// long Bedrock stream never starts on credentials that lapse mid-request.
const REFRESH_MARGIN_MS = 5 * 60_000;

export type AssumedRoleCredentials = AwsSigV4ProviderAuth & {
  session_token: string;
  expires_at: number;
};

export type AssumeRoleFn = (
  auth: AwsAssumeRoleProviderAuth,
) => Promise<AssumedRoleCredentials>;

export type AwsRoleCredentials = {
  /** Swap an AssumeRole auth for temporary SigV4 credentials; other auth passes through. */
  resolve(auth: ProviderAuth): Promise<ResolvedProviderAuth>;
  /** Temporary credential values already issued for this role, for log scrubbing. */
  secrets(auth: AwsAssumeRoleProviderAuth): string[];
};

export function createAwsRoleCredentials(deps: {
  assumeRole: AssumeRoleFn;
  now?: () => number;
}): AwsRoleCredentials {
  const now = deps.now ?? Date.now;
  const issued = new Map<string, AssumedRoleCredentials>();
  // Credentials replaced by a refresh stay scrubbable until they expire:
  // a stream that started before the refresh still signs with them.
  const retired = new Map<string, AssumedRoleCredentials[]>();
  const inflight = new Map<string, Promise<AssumedRoleCredentials>>();

  function assume(auth: AwsAssumeRoleProviderAuth): Promise<AssumedRoleCredentials> {
    const key = cacheKey(auth);
    const cached = issued.get(key);
    if (cached && cached.expires_at - now() > REFRESH_MARGIN_MS) {
      return Promise.resolve(cached);
    }
    let pending = inflight.get(key);
    if (!pending) {
      pending = deps.assumeRole(auth)
        .then((credentials) => {
          const previous = issued.get(key);
          if (previous) {
            retired.set(key, [
              ...(retired.get(key) ?? []).filter((c) => c.expires_at > now()),
              previous,
            ]);
          }
          issued.set(key, credentials);
          return credentials;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }

  return {
    async resolve(auth) {
      if (auth.type !== "aws_assume_role") return auth;
      const { expires_at: _expiresAt, ...credentials } = await assume(auth);
      return credentials;
    },
    secrets(auth) {
      const key = cacheKey(auth);
      const current = issued.get(key);
      const live = [
        ...(current ? [current] : []),
        ...(retired.get(key) ?? []).filter((c) => c.expires_at > now()),
      ];
      return live.flatMap((c) => [c.access_key_id, c.secret_access_key, c.session_token]);
    },
  };
}

function cacheKey(auth: AwsAssumeRoleProviderAuth): string {
  return `${auth.role_arn}\n${auth.external_id}\n${auth.region}`;
}

async function stsAssumeRole(
  auth: AwsAssumeRoleProviderAuth,
): Promise<AssumedRoleCredentials> {
  const accessKeyId = process.env.DARI_AWS_ASSUME_ROLE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.DARI_AWS_ASSUME_ROLE_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new HttpError(
      500,
      "DARI_AWS_ASSUME_ROLE_ACCESS_KEY_ID and DARI_AWS_ASSUME_ROLE_SECRET_ACCESS_KEY are not configured.",
      "configuration_error",
    );
  }
  const client = new STSClient({
    region: STS_REGION,
    credentials: { accessKeyId, secretAccessKey },
  });
  let result;
  try {
    result = await client.send(
      new AssumeRoleCommand({
        RoleArn: auth.role_arn,
        ExternalId: auth.external_id,
        RoleSessionName: ROLE_SESSION_NAME,
      }),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`AWS AssumeRole for ${auth.role_arn} failed: ${reason}`);
  } finally {
    client.destroy();
  }
  const credentials = result.Credentials;
  if (
    !credentials?.AccessKeyId
    || !credentials.SecretAccessKey
    || !credentials.SessionToken
    || !credentials.Expiration
  ) {
    throw new Error(`AWS AssumeRole for ${auth.role_arn} returned incomplete credentials.`);
  }
  return {
    type: "aws_sigv4",
    access_key_id: credentials.AccessKeyId,
    secret_access_key: credentials.SecretAccessKey,
    session_token: credentials.SessionToken,
    region: auth.region,
    expires_at: credentials.Expiration.getTime(),
  };
}

export const awsRoleCredentials = createAwsRoleCredentials({ assumeRole: stsAssumeRole });
