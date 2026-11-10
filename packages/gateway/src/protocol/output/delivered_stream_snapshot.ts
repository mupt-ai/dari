const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** Bounded record of protocol frames actually handed to the client stream. */
export class DeliveredStreamSnapshot {
  private readonly events: unknown[] = [];
  private encodedBytes = 0;
  private truncated = false;

  constructor(private readonly protocol: string) {}

  record(event: unknown): void {
    if (this.truncated) return;
    const encoded = JSON.stringify(event);
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (this.encodedBytes + bytes > MAX_SNAPSHOT_BYTES) {
      this.truncated = true;
      return;
    }
    this.events.push(event);
    this.encodedBytes += bytes;
  }

  body(): Record<string, unknown> {
    return {
      type: "dari.stream_partial",
      protocol: this.protocol,
      events: this.events,
      truncated: this.truncated,
    };
  }
}
