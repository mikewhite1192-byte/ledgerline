import type { Queryable } from "../../../db";
import { isCanonicalUuid } from "../../../money/keys";
import { MoneyError } from "../../../money/types";
import { openToken, sealToken } from "./crypto";
import { tenantCodeOf } from "./entities";
import { ACCOUNT_ROLES, ITEM_NAMES, type AccountMap, type ItemMap } from "./mapping";
import type { Tokens } from "./oauth";

// The tenant's QuickBooks rows (0007), always inside the caller's tenant transaction. Every
// statement names its tenant (current_tenant_id()), so it stays on one tenant even under a login
// that ignores row-level security. Tokens cross the Queryable as base64 text (decode/encode in
// the SQL), because a parameter is text, a number, a boolean or null. Expiry is judged by the
// database clock.

export type Connection = {
  tenantId: string;
  realmId: string;
  accessToken: string;
  refreshToken: string;
  // The access token ends within 60 seconds (database clock).
  expiring: boolean;
  refreshExpired: boolean;
  accounts: AccountMap;
  items: ItemMap;
  // The tenant's document key (0015), or null when it has none that reads right; a document
  // that needs it then refuses before anything is sent.
  docKey: string | null;
};

const DOC_KEY = /^T[0-9A-F]{4}$/;
const OUTSIDE_ID = /^[0-9]{1,20}$/;

export async function currentTenantId(q: Queryable): Promise<string> {
  const rows = await q.query<{ id: unknown }>("SELECT CAST(current_tenant_id() AS text) AS id");
  const id = rows.length === 1 ? rows[0].id : null;
  if (!isCanonicalUuid(id)) throw new MoneyError("validation");
  return id;
}

// The current tenant's code for customer and vendor names in a company several tenants may share
// (D2): T and the first 12 hex digits of its id, uppercase (tenantCodeOf), never its slug. A
// missing or malformed tenant id, or a code of any other shape, is refused.
export async function tenantCode(q: Queryable): Promise<string> {
  const code = tenantCodeOf(await currentTenantId(q));
  if (!/^T[0-9A-F]{12}$/.test(code)) throw new MoneyError("validation");
  return code;
}

function mapFrom<K extends string>(text: unknown, keys: readonly K[]): Record<K, string> {
  let parsed: unknown;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MoneyError("not_configured");
  }
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const v = (parsed as Record<string, unknown>)[k];
    if (typeof v !== "string" || !OUTSIDE_ID.test(v)) throw new MoneyError("not_configured");
    out[k] = v;
  }
  return out;
}

type Row = {
  realm_id: unknown;
  access_enc: unknown;
  refresh_enc: unknown;
  expiring: unknown;
  refresh_expired: unknown;
  account_map: unknown;
  item_map: unknown;
  doc_key: unknown;
};

const base64 = (v: unknown): Buffer => {
  if (typeof v !== "string") throw new MoneyError("not_connected");
  // encode(..., 'base64') wraps lines; the newlines are not part of the value.
  return Buffer.from(v.replace(/\s+/g, ""), "base64");
};

// The tenant's connection, tokens opened, or null when it has none. lock takes the row FOR
// UPDATE, so one refresh runs at a time and the rotated token is not lost to a second one.
export async function loadConnection(
  q: Queryable,
  key: Buffer,
  opts: { lock: boolean },
): Promise<Connection | null> {
  const tenantId = await currentTenantId(q);
  const rows = await q.query<Row>(
    `SELECT realm_id,
            encode(access_token_enc, 'base64') AS access_enc,
            encode(refresh_token_enc, 'base64') AS refresh_enc,
            (access_expires_at < now() + interval '60 seconds') AS expiring,
            (refresh_expires_at <= now()) AS refresh_expired,
            CAST(account_map AS text) AS account_map,
            CAST(item_map AS text) AS item_map,
            (SELECT t.doc_key FROM tenants t WHERE t.id = current_tenant_id()) AS doc_key
       FROM qbo_connections
      WHERE tenant_id = current_tenant_id()${opts.lock ? "\n      FOR UPDATE" : ""}`,
  );
  if (rows.length === 0) return null;
  const [r] = rows;
  if (typeof r.realm_id !== "string" || !/^[0-9]{10,20}$/.test(r.realm_id)) {
    throw new MoneyError("not_connected");
  }
  const realmId = r.realm_id;
  return {
    tenantId,
    realmId,
    accessToken: openToken(key, base64(r.access_enc), tenantId, realmId, "access"),
    refreshToken: openToken(key, base64(r.refresh_enc), tenantId, realmId, "refresh"),
    expiring: r.expiring === true,
    refreshExpired: r.refresh_expired === true,
    accounts: mapFrom(r.account_map, ACCOUNT_ROLES),
    items: mapFrom(r.item_map, ITEM_NAMES),
    docKey: typeof r.doc_key === "string" && DOC_KEY.test(r.doc_key) ? r.doc_key : null,
  };
}

function sealed(key: Buffer, tokens: Tokens, tenantId: string, realmId: string) {
  return {
    access: sealToken(key, tokens.accessToken, tenantId, realmId, "access").toString("base64"),
    refresh: sealToken(key, tokens.refreshToken, tenantId, realmId, "refresh").toString("base64"),
  };
}

// A new or replaced connection (connect and reconnect).
export async function saveConnection(
  q: Queryable,
  key: Buffer,
  c: {
    realmId: string;
    tokens: Tokens;
    accounts: AccountMap;
    items: ItemMap;
    membershipId: string;
  },
): Promise<void> {
  const tenantId = await currentTenantId(q);
  const enc = sealed(key, c.tokens, tenantId, c.realmId);
  const n = await q.execute(
    `INSERT INTO qbo_connections (tenant_id, realm_id, access_token_enc, refresh_token_enc,
                                  access_expires_at, refresh_expires_at, account_map, item_map,
                                  connected_by_membership_id)
     VALUES (current_tenant_id(), $1, decode($2, 'base64'), decode($3, 'base64'),
             now() + make_interval(secs => CAST($4 AS integer)),
             now() + make_interval(secs => CAST($5 AS integer)),
             CAST($6 AS jsonb), CAST($7 AS jsonb), CAST($8 AS uuid))
     ON CONFLICT (tenant_id) DO UPDATE
        SET realm_id = EXCLUDED.realm_id,
            access_token_enc = EXCLUDED.access_token_enc,
            refresh_token_enc = EXCLUDED.refresh_token_enc,
            access_expires_at = EXCLUDED.access_expires_at,
            refresh_expires_at = EXCLUDED.refresh_expires_at,
            account_map = EXCLUDED.account_map,
            item_map = EXCLUDED.item_map,
            connected_by_membership_id = EXCLUDED.connected_by_membership_id,
            connected_at = now(),
            refreshed_at = now()`,
    [
      c.realmId,
      enc.access,
      enc.refresh,
      c.tokens.accessExpiresIn,
      c.tokens.refreshExpiresIn,
      JSON.stringify(c.accounts),
      JSON.stringify(c.items),
      c.membershipId,
    ],
  );
  if (n !== 1) throw new MoneyError("unknown");
}

// Both new tokens after a refresh, on the row the caller holds FOR UPDATE.
export async function storeRefreshed(
  q: Queryable,
  key: Buffer,
  conn: Connection,
  tokens: Tokens,
): Promise<void> {
  const enc = sealed(key, tokens, conn.tenantId, conn.realmId);
  const n = await q.execute(
    `UPDATE qbo_connections
        SET access_token_enc = decode($1, 'base64'),
            refresh_token_enc = decode($2, 'base64'),
            access_expires_at = now() + make_interval(secs => CAST($3 AS integer)),
            refresh_expires_at = now() + make_interval(secs => CAST($4 AS integer)),
            refreshed_at = now()
      WHERE tenant_id = current_tenant_id() AND realm_id = $5`,
    [enc.access, enc.refresh, tokens.accessExpiresIn, tokens.refreshExpiresIn, conn.realmId],
  );
  if (n !== 1) throw new MoneyError("not_connected");
}

export async function deleteConnection(q: Queryable): Promise<number> {
  return q.execute("DELETE FROM qbo_connections WHERE tenant_id = current_tenant_id()");
}

export type EntityTable = "customers" | "drivers";

export async function readEntityId(
  q: Queryable,
  table: EntityTable,
  localId: string,
): Promise<string | null> {
  const rows = await q.query<{ outside_id: unknown }>(
    `SELECT outside_id FROM qbo_entity_ids
      WHERE tenant_id = current_tenant_id() AND local_table = $1 AND local_id = CAST($2 AS uuid)`,
    [table, localId],
  );
  if (rows.length === 0) return null;
  const id = rows[0].outside_id;
  if (typeof id !== "string" || !OUTSIDE_ID.test(id)) throw new MoneyError("unknown");
  return id;
}

// Whether a QuickBooks customer id is one this tenant made or adopted for one of its customers.
// A document whose customer is not is never ours, whatever its number says.
export async function isTenantCustomer(q: Queryable, outsideId: string): Promise<boolean> {
  const rows = await q.query<{ ok: unknown }>(
    `SELECT 1 AS ok FROM qbo_entity_ids
      WHERE tenant_id = current_tenant_id() AND local_table = 'customers' AND outside_id = $1
      LIMIT 1`,
    [outsideId],
  );
  return rows.length > 0;
}

// Keeps the first id stored for a local row; returns the one that is stored.
export async function storeEntityId(
  q: Queryable,
  table: EntityTable,
  localId: string,
  outsideId: string,
): Promise<string> {
  await q.execute(
    `INSERT INTO qbo_entity_ids (id, tenant_id, local_table, local_id, entity_type, outside_id)
     VALUES (gen_random_uuid(), current_tenant_id(), $1, CAST($2 AS uuid), $3, $4)
     ON CONFLICT (tenant_id, local_table, local_id) DO NOTHING`,
    [table, localId, table === "customers" ? "Customer" : "Vendor", outsideId],
  );
  const stored = await readEntityId(q, table, localId);
  if (!stored) throw new MoneyError("unknown");
  return stored;
}

export async function addOAuthState(q: Queryable, state: string, membershipId: string): Promise<void> {
  // Old states go first; a state is good for ten minutes.
  await q.execute(
    `DELETE FROM qbo_oauth_states
      WHERE tenant_id = current_tenant_id() AND created_at < now() - interval '10 minutes'`,
  );
  await q.execute(
    `INSERT INTO qbo_oauth_states (id, tenant_id, state, membership_id)
     VALUES (gen_random_uuid(), current_tenant_id(), $1, CAST($2 AS uuid))`,
    [state, membershipId],
  );
}

// Removes the state whatever its age (it is single use), and returns its membership and whether
// it was still fresh, or null when there is no such state in this tenant.
export async function takeOAuthState(
  q: Queryable,
  state: string,
): Promise<{ membershipId: string; fresh: boolean } | null> {
  const rows = await q.query<{ membership_id: unknown; fresh: unknown }>(
    `DELETE FROM qbo_oauth_states
      WHERE tenant_id = current_tenant_id() AND state = $1
     RETURNING CAST(membership_id AS text) AS membership_id,
               (created_at >= now() - interval '10 minutes') AS fresh`,
    [state],
  );
  if (rows.length !== 1) return null;
  const [r] = rows;
  if (!isCanonicalUuid(r.membership_id)) return null;
  return { membershipId: r.membership_id, fresh: r.fresh === true };
}

// The signed-in person's membership in this tenant and its role.
export async function membershipOf(
  q: Queryable,
  sub: string,
): Promise<{ id: string; role: "admin" | "staff" } | null> {
  const rows = await q.query<{ id: unknown; role: unknown }>(
    `SELECT CAST(id AS text) AS id, role FROM memberships
      WHERE tenant_id = current_tenant_id() AND cognito_sub = $1`,
    [sub],
  );
  if (rows.length !== 1) return null;
  const [r] = rows;
  if (!isCanonicalUuid(r.id) || (r.role !== "admin" && r.role !== "staff")) return null;
  return { id: r.id, role: r.role };
}

// What the settings page shows: the company id's last four digits only.
export async function connectionSummary(
  q: Queryable,
): Promise<{ realmTail: string; connectedAt: string } | null> {
  const rows = await q.query<{ realm_id: unknown; connected_at: unknown }>(
    `SELECT realm_id, to_char(connected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS connected_at
       FROM qbo_connections WHERE tenant_id = current_tenant_id()`,
  );
  if (rows.length !== 1) return null;
  const [r] = rows;
  if (typeof r.realm_id !== "string" || typeof r.connected_at !== "string") return null;
  return { realmTail: r.realm_id.slice(-4), connectedAt: r.connected_at };
}
