import { expect, test } from "bun:test";

import { requestTags } from "./request_tags.js";

test("tags parse as trimmed key=value pairs", () => {
  expect(requestTags("run=r1, trial=3,setting=a=b")).toEqual({ run: "r1", trial: "3", setting: "a=b" });
  expect(requestTags(null)).toEqual({});
  expect(requestTags("  ")).toEqual({});
});

test("malformed or oversized tags are refused", () => {
  for (const header of ["run", "=r1", "bad key=1", `k=${"v".repeat(257)}`, "x".repeat(2049)]) {
    expect(() => requestTags(header)).toThrow();
  }
  expect(() => requestTags(Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(","))).toThrow();
});
