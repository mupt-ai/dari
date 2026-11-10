import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { anthropicToken, bearerToken } from "./auth.js";

const INTERNAL_TOKEN = "internal-secret-1234";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.DARI_ROUTING_INTERNAL_TOKEN;
  process.env.DARI_ROUTING_INTERNAL_TOKEN = INTERNAL_TOKEN;
});

afterEach(() => {
  if (previous === undefined) delete process.env.DARI_ROUTING_INTERNAL_TOKEN;
  else process.env.DARI_ROUTING_INTERNAL_TOKEN = previous;
});

describe("public routing tokens", () => {
  test("rejects the internal token on public inference", () => {
    const headers = new Headers({ Authorization: `Bearer ${INTERNAL_TOKEN}` });
    expect(() => bearerToken(headers)).toThrow(
      "Internal routing credentials cannot authorize public inference.",
    );
  });

  test("passes through a key with the same character count but other bytes", () => {
    // Same JavaScript length as the secret, different UTF-8 byte length.
    const lookalike = `${INTERNAL_TOKEN.slice(0, -1)}\u00e9`;
    expect(lookalike.length).toBe(INTERNAL_TOKEN.length);
    expect(Buffer.byteLength(lookalike)).not.toBe(Buffer.byteLength(INTERNAL_TOKEN));

    expect(bearerToken(new Headers({ Authorization: `Bearer ${lookalike}` }))).toBe(lookalike);
    expect(anthropicToken(new Headers({ "x-api-key": lookalike }))).toBe(lookalike);
  });

  test("passes through ordinary routing keys", () => {
    expect(bearerToken(new Headers({ Authorization: "Bearer dari_abc" }))).toBe("dari_abc");
    expect(anthropicToken(new Headers({ "x-api-key": "dari_abc" }))).toBe("dari_abc");
  });
});
