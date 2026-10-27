import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "../db";
import { isUuid } from "../uuid";

// Access codes for the fictional portal (design 3.2). The portal stores no passwords: starting a
// run, or a person asking to browse it, mints a session row with a one-time code. The code signs
// in once, within 20 minutes; the signed-in session then lives 60 minutes. Only the code's sha256
// is stored. Every function takes the clock, so tests never read the wall clock.

// 32 characters, no 0, O, 1 or I: a byte masked to 5 bits picks one with no bias.
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 20 * 60_000;
export const SESSION_TTL_MS = 60 * 60_000;
// At this many misses inside one minute, the tenant's sign-in form refuses every entry, even a
// right one, until the minute that began with the first miss is over.
export const SIGN_IN_FAILURE_LIMIT = 10;
const CODE_SHAPE = /^[2-9A-HJ-NP-Z]{8}$/;
const CARRIER_NUMBER = /^MC-[0-9]{6}$/;

export function mintCode(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(CODE_LENGTH);
  if (bytes.length !== CODE_LENGTH) throw new Error("not enough random bytes");
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b & 31];
  return code;
}

// What a person typed, as a code: spaces and dashes dropped, upper case. Null when it cannot be
// a code at all, so a malformed entry never reaches the database.
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const code = raw.replace(/[\s-]/g, "").toUpperCase();
  return CODE_SHAPE.test(code) ? code : null;
}

export function normalizeCarrierNumber(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const value = raw.trim().toUpperCase();
  return CARRIER_NUMBER.test(value) ? value : null;
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export type MintedSession = { sessionId: string; code: string; expiresAt: string };

// Inside a tenant transaction: one new session for the transaction's tenant.
export async function mintSession(
  q: Queryable,
  input: { runId: string | null; createdBy: string; now: Date },
  random: (n: number) => Uint8Array = randomBytes,
): Promise<MintedSession> {
  const sessionId = randomUUID();
  const code = mintCode(random);
  const expiresAt = new Date(input.now.getTime() + CODE_TTL_MS).toISOString();
  await q.execute(
    "INSERT INTO portal_sessions (id, tenant_id, run_id, code_hash, expires_at, created_by)" +
      " VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, CAST($4 AS timestamptz), $5)",
    [sessionId, input.runId, hashCode(code), expiresAt, input.createdBy],
  );
  return { sessionId, code, expiresAt };
}

// A miss counts toward the limit: the first in a new minute starts that minute's count at one.
const COUNT_MISS =
  "UPDATE portal_accounts SET" +
  " failed_sign_ins = CASE WHEN failed_window_start > CAST($1 AS timestamptz) - interval '1 minute'" +
  " THEN failed_sign_ins + 1 ELSE 1 END," +
  " failed_window_start = CASE WHEN failed_window_start > CAST($1 AS timestamptz) - interval '1 minute'" +
  " THEN failed_window_start ELSE CAST($1 AS timestamptz) END" +
  " WHERE tenant_id = current_tenant_id()";

// Signs in with a carrier number and a code, inside the tenant's transaction. The carrier number
// must be this tenant's, whole; the code must be unexpired and never used. The UPDATE's own
// condition makes the code single use even when two sign-ins race. Returns the session id, or
// null for any miss (the page shows one message for all of them). Each miss is counted on the
// tenant's account row, locked first so concurrent tries count one after another; at the limit
// every entry is refused until the minute is over. A malformed entry never reaches the database,
// so it is refused without being counted.
export async function signIn(
  q: Queryable,
  input: { carrierNumber: string; code: string; now: Date },
): Promise<string | null> {
  const carrier = normalizeCarrierNumber(input.carrierNumber);
  const code = normalizeCode(input.code);
  if (!carrier || !code) return null;
  const now = input.now.toISOString();
  const accounts = await q.query<{ carrier_number: unknown; failed_sign_ins: unknown; window_open: unknown }>(
    "SELECT carrier_number, failed_sign_ins," +
      " (failed_window_start IS NOT NULL" +
      " AND failed_window_start > CAST($1 AS timestamptz) - interval '1 minute') AS window_open" +
      " FROM portal_accounts WHERE tenant_id = current_tenant_id() FOR UPDATE",
    [now],
  );
  if (accounts.length !== 1) return null;
  const account = accounts[0];
  // Unknown is not zero: a count or a window that did not read back as expected refuses.
  if (typeof account.failed_sign_ins !== "number" || typeof account.window_open !== "boolean") return null;
  if (account.window_open && account.failed_sign_ins >= SIGN_IN_FAILURE_LIMIT) return null;
  const sessionId = account.carrier_number === carrier ? await spendCode(q, code, input.now) : null;
  if (sessionId) return sessionId;
  await q.execute(COUNT_MISS, [now]);
  return null;
}

// Spends a live code: its session id, or null when no live code matches or another sign-in won.
async function spendCode(q: Queryable, code: string, at: Date): Promise<string | null> {
  const now = at.toISOString();
  const rows = await q.query<{ id: string }>(
    "SELECT id FROM portal_sessions WHERE tenant_id = current_tenant_id() AND code_hash = $1" +
      " AND signed_in_at IS NULL AND expires_at > CAST($2 AS timestamptz)",
    [hashCode(code), now],
  );
  if (rows.length !== 1) return null;
  const until = new Date(at.getTime() + SESSION_TTL_MS).toISOString();
  const n = await q.execute(
    "UPDATE portal_sessions SET signed_in_at = CAST($2 AS timestamptz)," +
      " session_expires_at = CAST($3 AS timestamptz)" +
      " WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND signed_in_at IS NULL" +
      " AND expires_at > CAST($2 AS timestamptz)",
    [rows[0].id, now, until],
  );
  return n === 1 ? rows[0].id : null;
}

// Whether a signed-in session is still alive.
export async function sessionAlive(q: Queryable, sessionId: string, now: Date): Promise<boolean> {
  if (!isUuid(sessionId)) return false;
  const rows = await q.query<{ ok: number }>(
    "SELECT 1 AS ok FROM portal_sessions WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)" +
      " AND session_expires_at > CAST($2 AS timestamptz)",
    [sessionId, now.toISOString()],
  );
  return rows.length === 1;
}

// The portal cookie carries the tenant and the session, both ids: the tenant picks the row
// security scope, the session row (in that scope) decides whether the cookie is any good.
export function cookieValue(tenantId: string, sessionId: string): string {
  return `${tenantId}.${sessionId}`;
}

export function parseCookie(value: unknown): { tenantId: string; sessionId: string } | null {
  if (typeof value !== "string" || value.length > 80) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !isUuid(parts[0]) || !isUuid(parts[1])) return null;
  return { tenantId: parts[0], sessionId: parts[1] };
}

// The portal cookie's options: never readable by page script, sent only to the portal's own
// paths, and gone when the session row dies.
export function portalCookieOptions(nodeEnv: string | undefined = process.env.NODE_ENV) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: nodeEnv === "production",
    path: "/portal",
    maxAge: SESSION_TTL_MS / 1000,
  };
}
