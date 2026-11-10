import { expect, test } from "bun:test";

import { scrubSecretValues, scrubSecrets } from "./scrub.js";

test("scrubs explicit AWS credential values from nested provider output", () => {
  const secrets = ["AKIAEXAMPLE", "secret-example", "session-example"];
  const value = scrubSecretValues(
    {
      errorMessage:
        "AWS rejected AKIAEXAMPLE with secret-example and session-example",
      nested: ["session-example", { value: "AKIAEXAMPLE" }],
    },
    secrets,
  );

  expect(value).toEqual({
    errorMessage: "AWS rejected … with … and …",
    nested: ["…", { value: "…" }],
  });
});

test("continues to scrub API keys without explicit secret context", () => {
  expect(scrubSecrets("invalid sk-verysecretkey9876 provided")).toBe(
    "invalid sk-… provided",
  );
});

test("scrubs the exact provider key from payload values", () => {
  const value = scrubSecretValues(
    { errorMessage: "401 for sk-live-router-key-0123456789" },
    ["sk-live-router-key-0123456789"],
  );

  expect(value).toEqual({ errorMessage: "401 for …" });
});

// Regression: OpenAI `encrypted_content` is opaque base64url whose bytes can
// spell `sk-` by chance. The heuristic used to truncate the ciphertext there,
// and Codex replayed the corrupted item on every later turn, so the provider
// rejected the whole thread with `invalid_encrypted_content`.
test("leaves opaque provider payload bytes containing sk- intact", () => {
  const encryptedContent =
    "gAAAAABqoaAr61lIFzzffIUuBnLrPxFSdx7GyekpjeG7yid5u0H9BWAkexSJpan6CCbQaxVv8Rteh4nfZo49weCJmTx2m-XmMyBEkRwkGP7unv3WOQBZueIPiCGTBGroD7ElOggnyvSrk5XfdhvhxalO8uGwEsiJUuO-GhUFBoI9Nob_NGSYCdxdocFiVL_hD7dS2fBLzyiPnMMIRft22kdunLk_TujTYNsj8vNqx4Rhxa1Y-CMMBjdIIm77LvR2FvUvE1jYcDJ0p7kvOE6GixFaPx8y9uqrex8siaqDEsaCdduH2Y2Pp2TwE2WFMQwGQc_FEz4iBpDT0gxJ1pwzjySF1e-STHfSCT29oadLN_u6jkr0kQn06wEhMfXhA1oWB-jJFiy_dAGt_JozXQE74vTR4frs8S-dzQQWcpMbxnTY9CPVR5QMXuXll_nPvWE5ChbSnzJHRL0C7KpRZyVqcnC19EmhRt8Rjo0WNtHtsz4Mx1Rr2m7H1srEzsk-GhUFBoI9Nob_NGSYCdxdocFiVL_hD7dS2fBLzyiPnMMIRft22kdunLk=";
  const message = {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Adjusting graphic design",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs_0145c231a5eb865a016aa1a026d00c87d1b05d2719a274ef1a",
          encrypted_content: encryptedContent,
        }),
      },
      { type: "text", text: "Rotate the key: sk-abcdefghijklmnop is compromised." },
    ],
  };

  expect(scrubSecretValues(message, ["sk-proj-router-key-not-in-payload"])).toEqual(message);
});
