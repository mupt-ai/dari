/* The Dari Link requests this gateway process is serving and has not yet
   recorded, so a usage read can say up to when its counts are complete.

   A request is counted from its report (RequestReporter) until its usage is
   recorded. Before its report exists a request is still resolving, so the
   answer also stays RESOLVE_SLACK_MS behind now. An entry older than
   STALE_MS (a child token's longest life) is taken as lost and dropped.

   This is exact only where one process serves and records every request of
   a grant: the self-hosted gateway. */

const RESOLVE_SLACK_MS = 30_000;
const STALE_MS = 12 * 60 * 60_000;

// Grant id -> request id -> when the request was received (ms).
const inFlight = new Map<string, Map<string, number>>();

export function linkRequestStarted(grantId: string, requestId: string, receivedAt: Date): void {
  let requests = inFlight.get(grantId);
  if (requests === undefined) {
    requests = new Map();
    inFlight.set(grantId, requests);
  }
  requests.set(requestId, receivedAt.getTime());
}

export function linkRequestRecorded(grantId: string, requestId: string): void {
  const requests = inFlight.get(grantId);
  if (requests === undefined) return;
  requests.delete(requestId);
  if (requests.size === 0) inFlight.delete(grantId);
}

/** Every request of the grant received before this time has been recorded. */
export function linkCompleteThrough(grantId: string, now = new Date()): Date {
  let through = now.getTime() - RESOLVE_SLACK_MS;
  const requests = inFlight.get(grantId);
  for (const [requestId, receivedAt] of requests ?? []) {
    if (receivedAt < now.getTime() - STALE_MS) {
      requests!.delete(requestId);
      continue;
    }
    through = Math.min(through, receivedAt);
  }
  return new Date(through);
}
