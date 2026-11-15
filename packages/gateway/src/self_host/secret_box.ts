/**
 * Encryption at rest for the secrets the gateway's database holds:
 * subscription tokens, pending sign-ins, and the API keys Dari Link users add.
 *
 * `DARI_GATEWAY_ENCRYPTION_KEY` holds one or more 32-byte keys, base64 or
 * base64url, comma-separated. The first encrypts; any of them decrypts, so a
 * key is rotated by putting the new one first and keeping the old one until
 * the gateway has started once (startup re-encrypts every stored secret under
 * the first key).
 *
 * Each value is sealed with AES-256-GCM under a fresh nonce and bound to the
 * row and column it belongs to, so a ciphertext copied into another row, or
 * another column, does not open. A sealed value reads
 * `enc:v1:<key id>:<base64url(nonce | ciphertext | tag)>`; the key id is the
 * first 8 hex characters of the key's SHA-256.
 *
 * Without a key the database holds secrets as they are, protected only by its
 * file permissions, and the gateway refuses to take other people's
 * subscriptions and keys on the Dari Link approval page.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBox {
  private readonly keys: Map<string, Buffer>;
  private readonly currentId: string;

  constructor(keys: readonly Buffer[]) {
    if (keys.length === 0 || keys.some((key) => key.length !== 32)) {
      throw new Error("Each encryption key must be 32 bytes.");
    }
    this.keys = new Map(keys.map((key) => [keyId(key), key]));
    this.currentId = keyId(keys[0]!);
  }

  /** Encrypt a value for one place: `where` names its table, row, and column. */
  seal(plaintext: string, where: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.currentId)!, nonce);
    cipher.setAAD(Buffer.from(where));
    const sealed = Buffer.concat([nonce, cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${PREFIX}${this.currentId}:${sealed.toString("base64url")}`;
  }

  /**
   * The value stored at `where`. Throws when it is not sealed (a value written
   * into the database around the gateway), was sealed for another place, was
   * altered, or needs a key this box does not hold.
   */
  open(stored: string, where: string): string {
    if (!isSealed(stored)) throw new Error(`A stored secret (${where}) is not encrypted.`);
    const [id, body] = stored.slice(PREFIX.length).split(":");
    const key = this.keys.get(id ?? "");
    if (key === undefined || body === undefined) {
      throw new Error(`A stored secret needs an encryption key (${id}) that DARI_GATEWAY_ENCRYPTION_KEY does not list.`);
    }
    const sealed = Buffer.from(body, "base64url");
    if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error(`A stored secret (${where}) does not open: it was altered or moved.`);
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(where));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()])
        .toString("utf8");
    } catch {
      throw new Error(`A stored secret (${where}) does not open: it was altered or moved.`);
    }
  }

  /** A stored value for re-sealing at startup: one stored before encryption was turned on is taken as it is. */
  adopt(stored: string, where: string): string {
    return isSealed(stored) ? this.open(stored, where) : stored;
  }

  /** Whether a stored value is sealed under the key that encrypts now. */
  current(stored: string): boolean {
    return stored.startsWith(`${PREFIX}${this.currentId}:`);
  }
}

/** Whether a stored value is encrypted. */
export function isSealed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** A value read without a box: itself, unless it is encrypted and so needs the key. */
export function openWithoutKey(stored: string): string {
  if (isSealed(stored)) {
    throw new Error("This gateway database is encrypted. Set DARI_GATEWAY_ENCRYPTION_KEY to the key it was encrypted with.");
  }
  return stored;
}

/** The box for `DARI_GATEWAY_ENCRYPTION_KEY`, or null when it is unset. */
export function secretBoxFromEnv(value: string | undefined): SecretBox | null {
  const keys = (value ?? "").split(",").map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0) return null;
  return new SecretBox(keys.map((key) => {
    const bytes = Buffer.from(key, key.includes("-") || key.includes("_") ? "base64url" : "base64");
    if (bytes.length !== 32) {
      throw new Error("DARI_GATEWAY_ENCRYPTION_KEY must be 32-byte keys in base64, such as `openssl rand -base64 32` prints.");
    }
    return bytes;
  }));
}

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}
