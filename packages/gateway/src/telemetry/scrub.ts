// Error text can quote a credential the provider echoed back, so it gets the
// `sk-` heuristic on top of exact-secret replacement.
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  return replaceSecrets(text.replace(/sk-[A-Za-z0-9+/_=-]{8,}/g, "sk-…"), secrets);
}

// Provider payloads carry opaque base64 (OpenAI `encrypted_content`, image
// data, signatures) where `sk-` occurs by chance. The regex heuristic would
// truncate that ciphertext and poison every later turn of the conversation,
// so structured payloads only get exact-secret replacement; error text is
// scrubbed with the heuristic at the client and log boundaries.
export function scrubSecretValues(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (typeof value === "string") return replaceSecrets(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => scrubSecretValues(item, secrets));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      scrubSecretValues(item, secrets),
    ]),
  );
}

function replaceSecrets(text: string, secrets: readonly string[]): string {
  const uniqueSecrets = [...new Set(secrets.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  let scrubbed = text;
  for (const secret of uniqueSecrets) {
    scrubbed = scrubbed.replaceAll(secret, "…");
  }
  return scrubbed;
}
