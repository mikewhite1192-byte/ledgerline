import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MoneyError } from "../../../money/types";

// The QuickBooks tokens at rest: AES-256-GCM under a 32-byte key that never reaches the database.
// A sealed value is nonce (12 bytes), ciphertext, tag (16 bytes). The additional data binds it to
// the tenant, the company id and which token it is, so a value copied to another tenant, another
// company or the other column does not open.

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type TokenKind = "access" | "refresh";

// The key from its base64 text (`openssl rand -base64 32`): exactly 32 bytes, or null.
export function tokenKeyFrom(text: string | null | undefined): Buffer | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(text)) return null;
  const key = Buffer.from(text, "base64");
  return key.length === 32 ? key : null;
}

function aadOf(tenantId: string, realmId: string, kind: TokenKind): Buffer {
  return Buffer.from(`ledgerline:qbo-token:v1:${tenantId}:${realmId}:${kind}`, "utf8");
}

export function sealToken(
  key: Buffer,
  token: string,
  tenantId: string,
  realmId: string,
  kind: TokenKind,
  nonce: Buffer = randomBytes(NONCE_BYTES),
): Buffer {
  if (key.length !== 32 || nonce.length !== NONCE_BYTES) throw new MoneyError("not_configured");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(tenantId, realmId, kind));
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

// Throws MoneyError("not_connected") for anything that does not open: a wrong key, another
// tenant's or company's value, the other token's column, or a damaged value. A person reconnects.
export function openToken(
  key: Buffer,
  sealed: Buffer,
  tenantId: string,
  realmId: string,
  kind: TokenKind,
): string {
  if (key.length !== 32 || sealed.length <= NONCE_BYTES + TAG_BYTES) {
    throw new MoneyError("not_connected");
  }
  try {
    const nonce = sealed.subarray(0, NONCE_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadOf(tenantId, realmId, kind));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new MoneyError("not_connected");
  }
}
