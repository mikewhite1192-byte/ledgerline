import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { createPgDb } from "../../../db/pg";
import { adminUrl, appUrl } from "../../../db/test-urls";
import type { Db, Queryable } from "../../../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../../../money/test-db";
import { createQboAdapter } from "./adapter";
import type { FetchLike } from "./oauth";
import { createQboConnect, type TenantRun } from "./connect";
import {
  addOAuthState,
  connectionSummary,
  loadConnection,
  saveConnection,
  storeEntityId,
  takeOAuthState,
} from "./store";
import {
  ACCOUNTS,
  ITEMS,
  KEY,
  NEW_ACCESS,
  NEW_REFRESH,
  qboEnv,
  REALM,
  REALM_OFF_BY_ONE,
  tokenReply,
} from "./test-fakes";

// 0007 and the QuickBooks store as the app role sees them, and the whole connect flow against a
// made-up company answered in memory: no request leaves this machine. Every tenant made here is
// removed at the end, its QuickBooks rows with it.

const saved = { ...flags };
let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let secondAdminSub: string;

const TOKENS = {
  accessToken: `access-${"5".repeat(24)}`,
  refreshToken: `refresh-${"6".repeat(24)}`,
  accessExpiresIn: 3600,
  refreshExpiresIn: 8_726_400,
};

const inA = <T>(fn: (q: Queryable) => Promise<T>) => app.withTenant(A.tenantId, fn);
const inB = <T>(fn: (q: Queryable) => Promise<T>) => app.withTenant(B.tenantId, fn);
const runA: TenantRun = (fn) => app.withTenant(A.tenantId, fn);
const runB: TenantRun = (fn) => app.withTenant(B.tenantId, fn);

// A company in memory: Intuit's token, revoke and accounting calls, answered by what they ask.
function company() {
  const sent: { url: URL; method: string; body: string | null }[] = [];
  let next = 300;
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = typeof init.body === "string" ? init.body : null;
    sent.push({ url: u, method: init.method ?? "GET", body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (u.host === "oauth.platform.intuit.com") {
      const grant = new URLSearchParams(body ?? "").get("grant_type");
      return json(200, grant === "refresh_token" ? tokenReply() : tokenReply(TOKENS.accessToken, TOKENS.refreshToken));
    }
    if (u.host === "developer.api.intuit.com") return new Response("", { status: 200 });
    const query = u.searchParams.get("query") ?? "";
    if (query.includes("'Accounts Receivable'")) return json(200, { QueryResponse: { Account: [{ Id: "8" }] } });
    if (query.includes("'Accounts Payable'")) return json(200, { QueryResponse: { Account: [{ Id: "9" }] } });
    if (query) return json(200, { QueryResponse: {} });
    next += 1;
    const entity = u.pathname.split("/").pop() ?? "";
    const name = { account: "Account", item: "Item", customer: "Customer" }[entity] ?? "Unknown";
    return json(200, { [name]: { Id: String(next) } });
  };
  return { fetch, sent };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state") ?? "";

async function clearQbo(f: Fixture) {
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute("DELETE FROM qbo_connections WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM qbo_oauth_states WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM qbo_entity_ids WHERE tenant_id = current_tenant_id()");
  });
}

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
  const tag = randomUUID().slice(0, 8);
  A = await makeTenant(admin, `qbo-a-${tag}`);
  B = await makeTenant(admin, `qbo-b-${tag}`);
  secondAdminSub = `sub-second-${A.tenantId}`;
  await admin.withTenant(A.tenantId, async (q) => {
    await q.execute("UPDATE memberships SET role = 'admin' WHERE tenant_id = current_tenant_id()");
    await q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
       VALUES (current_tenant_id(), $1, 'second@qbo.example', 'admin')`,
      [secondAdminSub],
    );
  });
});

afterEach(async () => {
  Object.assign(flags, saved);
  await clearQbo(A);
  await clearQbo(B);
});

afterAll(async () => {
  Object.assign(flags, saved);
  await dropTenant(admin, A);
  await dropTenant(admin, B);
  await app?.close();
  await admin?.close();
});

const mapping = { realmId: REALM, tokens: TOKENS, accounts: ACCOUNTS, items: ITEMS };

describe("0007 QuickBooks tables", () => {
  it("grants the app role what the store needs: no update on states, no update or delete on outside ids", async () => {
    const rows = await admin.withoutTenant((q) =>
      q.query<{ t: string; s: boolean; i: boolean; u: boolean; d: boolean }>(
        `SELECT t,
                has_table_privilege('payday_app', t, 'SELECT') AS s,
                has_table_privilege('payday_app', t, 'INSERT') AS i,
                has_table_privilege('payday_app', t, 'UPDATE') AS u,
                has_table_privilege('payday_app', t, 'DELETE') AS d
           FROM unnest(ARRAY['qbo_connections', 'qbo_oauth_states', 'qbo_entity_ids']) AS t
          ORDER BY t`,
      ),
    );
    expect(rows).toEqual([
      { t: "qbo_connections", s: true, i: true, u: true, d: true },
      { t: "qbo_entity_ids", s: true, i: true, u: false, d: false },
      { t: "qbo_oauth_states", s: true, i: true, u: false, d: true },
    ]);
    // The app role cannot change a state, so a stale one cannot be made fresh again.
    const state = "u".repeat(43);
    await inA((q) => addOAuthState(q, state, A.memberId));
    expect(
      await sqlStateOf(
        inA((q) => q.execute("UPDATE qbo_oauth_states SET created_at = now() WHERE tenant_id = current_tenant_id()")),
      ),
    ).toBe("42501");
  });

  it("keeps each tenant's connection behind its wall", async () => {
    await inA((q) => saveConnection(q, KEY, { ...mapping, membershipId: A.memberId }));
    const seen = await inB((q) =>
      q.query<{ n: number }>(
        "SELECT CAST(count(*) AS integer) AS n FROM qbo_connections WHERE tenant_id = CAST($1 AS uuid)",
        [A.tenantId],
      ),
    );
    expect(seen[0].n).toBe(0);
    expect(await inB((q) => loadConnection(q, KEY, { lock: false }))).toBeNull();
    // Writing into another tenant is refused by the policy.
    expect(
      await sqlStateOf(
        inB((q) =>
          q.execute(
            `INSERT INTO qbo_oauth_states (id, tenant_id, state, membership_id)
             VALUES (gen_random_uuid(), CAST($1 AS uuid), $2, CAST($3 AS uuid))`,
            [A.tenantId, "s".repeat(43), A.memberId],
          ),
        ),
      ),
    ).toBe("42501");
  });

  it("refuses a connection made by another tenant's member", async () => {
    expect(await sqlStateOf(inB((q) => saveConnection(q, KEY, { ...mapping, membershipId: A.memberId })))).toBe(
      "23503",
    );
  });

  it("keeps the first outside id and lets the app neither change nor remove it", async () => {
    expect(await inA((q) => storeEntityId(q, "customers", A.customerId, "58"))).toBe("58");
    expect(await inA((q) => storeEntityId(q, "customers", A.customerId, "59"))).toBe("58");
    expect(
      await sqlStateOf(inA((q) => q.execute("UPDATE qbo_entity_ids SET outside_id = '60' WHERE tenant_id = current_tenant_id()"))),
    ).toBe("42501");
    expect(
      await sqlStateOf(inA((q) => q.execute("DELETE FROM qbo_entity_ids WHERE tenant_id = current_tenant_id()"))),
    ).toBe("42501");
  });
});

describe("QuickBooks store", () => {
  it("seals the tokens at rest and opens them only in their own tenant", async () => {
    await inA((q) => saveConnection(q, KEY, { ...mapping, membershipId: A.memberId }));
    const raw = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ a: string }>(
        "SELECT encode(access_token_enc, 'base64') AS a FROM qbo_connections WHERE tenant_id = current_tenant_id()",
      ),
    );
    expect(Buffer.from(raw[0].a.replace(/\s+/g, ""), "base64").toString("utf8")).not.toContain(TOKENS.accessToken);
    const conn = await inA((q) => loadConnection(q, KEY, { lock: true }));
    expect(conn).toMatchObject({
      tenantId: A.tenantId,
      realmId: REALM,
      accessToken: TOKENS.accessToken,
      refreshToken: TOKENS.refreshToken,
      expiring: false,
      refreshExpired: false,
      accounts: ACCOUNTS,
      items: ITEMS,
    });
    expect(await inA(connectionSummary)).toMatchObject({ realmTail: REALM.slice(-4) });
    // The same ciphertext copied to another tenant does not open there.
    await admin.withTenant(B.tenantId, (q) =>
      q.execute(
        `INSERT INTO qbo_connections (tenant_id, realm_id, access_token_enc, refresh_token_enc,
           access_expires_at, refresh_expires_at, account_map, item_map, connected_by_membership_id)
         SELECT current_tenant_id(), realm_id, access_token_enc, refresh_token_enc, access_expires_at,
                refresh_expires_at, account_map, item_map, CAST($2 AS uuid)
           FROM qbo_connections WHERE tenant_id = CAST($1 AS uuid)`,
        [A.tenantId, B.memberId],
      ),
    );
    await expect(inB((q) => loadConnection(q, KEY, { lock: false }))).rejects.toMatchObject({
      category: "not_connected",
    });
  });

  it("uses a state once, and says when it is stale or not this tenant's", async () => {
    const state = "a".repeat(43);
    await inA((q) => addOAuthState(q, state, A.memberId));
    expect(await inB((q) => takeOAuthState(q, state))).toBeNull();
    expect(await inA((q) => takeOAuthState(q, state))).toEqual({ membershipId: A.memberId, fresh: true });
    expect(await inA((q) => takeOAuthState(q, state))).toBeNull();

    await inA((q) => addOAuthState(q, state, A.memberId));
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE qbo_oauth_states SET created_at = created_at - interval '11 minutes' WHERE tenant_id = current_tenant_id()",
      ),
    );
    expect(await inA((q) => takeOAuthState(q, state))).toEqual({ membershipId: A.memberId, fresh: false });
  });
});

describe("QuickBooks connect", () => {
  it("connects an admin to the allowed company, sets up accounts and items, then disconnects", async () => {
    // Creating the accounts and items is a write to the company: it needs the accounting switch.
    flags.accountingEnabled = true;
    const c = company();
    const qbo = createQboConnect({ env: qboEnv(), fetch: c.fetch, log: () => {} });
    const started = await qbo.start(runA, A.session.sub);
    if (!started.ok) throw new Error(`start refused: ${started.reason}`);
    const state = stateOf(started.url);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const done = await qbo.finish(runA, A.session.sub, { code: "code-1", state, realmId: REALM, error: null });
    expect(done).toEqual({ ok: true });
    const conn = await inA((q) => loadConnection(q, KEY, { lock: false }));
    expect(conn).toMatchObject({ realmId: REALM, accessToken: TOKENS.accessToken, refreshToken: TOKENS.refreshToken });
    expect(conn?.accounts).toMatchObject({ accounts_receivable: "8", accounts_payable: "9" });
    // Seven named accounts and six items created in the company.
    expect(c.sent.filter((s) => s.method === "POST" && s.url.host.startsWith("sandbox-"))).toHaveLength(13);
    // The state is used up.
    expect(await qbo.finish(runA, A.session.sub, { code: "code-1", state, realmId: REALM, error: null })).toEqual({
      ok: false,
      reason: "expired",
    });

    expect(await qbo.disconnect(runA, A.session.sub)).toEqual({ ok: true, revoked: true });
    expect(c.sent.at(-1)?.url.host).toBe("developer.api.intuit.com");
    expect(await inA(connectionSummary)).toBeNull();
  });

  it("with the accounting switch off, creates nothing in the company, revokes the grant and stores nothing", async () => {
    flags.accountingEnabled = false;
    const c = company();
    const qbo = createQboConnect({ env: qboEnv(), fetch: c.fetch, log: () => {} });
    const started = await qbo.start(runA, A.session.sub);
    if (!started.ok) throw new Error(`start refused: ${started.reason}`);
    const out = await qbo.finish(runA, A.session.sub, {
      code: "code-1",
      state: stateOf(started.url),
      realmId: REALM,
      error: null,
    });
    expect(out).toEqual({ ok: false, reason: "disabled" });
    // The lookups went out; no create did, and the grant was revoked last.
    expect(c.sent.filter((s) => s.method === "POST" && s.url.host.startsWith("sandbox-"))).toHaveLength(0);
    expect(c.sent.some((s) => s.method === "GET" && s.url.host.startsWith("sandbox-"))).toBe(true);
    expect(c.sent.at(-1)?.url.host).toBe("developer.api.intuit.com");
    expect(await inA(connectionSummary)).toBeNull();
  });

  it("refuses a company one digit off, revokes the grant and stores nothing", async () => {
    const c = company();
    const qbo = createQboConnect({ env: qboEnv(), fetch: c.fetch, log: () => {} });
    const started = await qbo.start(runA, A.session.sub);
    if (!started.ok) throw new Error("start refused");
    const out = await qbo.finish(runA, A.session.sub, {
      code: "code-1",
      state: stateOf(started.url),
      realmId: REALM_OFF_BY_ONE,
      error: null,
    });
    expect(out).toEqual({ ok: false, reason: "not_allowed" });
    expect(c.sent.map((s) => s.url.host)).toEqual(["oauth.platform.intuit.com", "developer.api.intuit.com"]);
    expect(JSON.parse(c.sent[1].body ?? "")).toEqual({ token: TOKENS.refreshToken });
    expect(await inA(connectionSummary)).toBeNull();
  });

  it("refuses a stale state, another admin's state and a staff member, before calling Intuit", async () => {
    const c = company();
    const qbo = createQboConnect({ env: qboEnv(), fetch: c.fetch, log: () => {} });
    const stale = await qbo.start(runA, A.session.sub);
    if (!stale.ok) throw new Error("start refused");
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE qbo_oauth_states SET created_at = created_at - interval '11 minutes' WHERE tenant_id = current_tenant_id()",
      ),
    );
    const params = (url: string) => ({ code: "code-1", state: stateOf(url), realmId: REALM, error: null });
    expect(await qbo.finish(runA, A.session.sub, params(stale.url))).toEqual({ ok: false, reason: "expired" });

    const theirs = await qbo.start(runA, A.session.sub);
    if (!theirs.ok) throw new Error("start refused");
    expect(await qbo.finish(runA, secondAdminSub, params(theirs.url))).toEqual({ ok: false, reason: "forbidden" });

    expect(await qbo.start(runB, B.session.sub)).toEqual({ ok: false, reason: "forbidden" });
    expect(await qbo.disconnect(runB, B.session.sub)).toEqual({ ok: false, reason: "forbidden" });

    const declined = await qbo.start(runA, A.session.sub);
    if (!declined.ok) throw new Error("start refused");
    expect(
      await qbo.finish(runA, A.session.sub, { code: null, state: stateOf(declined.url), realmId: null, error: "access_denied" }),
    ).toEqual({ ok: false, reason: "declined" });
    expect(c.sent).toHaveLength(0);
  });

  it("refuses to start without complete settings", async () => {
    const qbo = createQboConnect({ env: qboEnv({ QBO_TOKEN_KEY: undefined }), fetch: company().fetch, log: () => {} });
    expect(await qbo.start(runA, A.session.sub)).toEqual({ ok: false, reason: "not_configured" });
  });
});

describe("QuickBooks adapter on the real store", () => {
  it("refreshes an expired access token under the row lock and stores both new tokens", async () => {
    flags.accountingEnabled = true;
    await inA((q) => saveConnection(q, KEY, { ...mapping, membershipId: A.memberId }));
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        "UPDATE qbo_connections SET access_expires_at = now() - interval '1 minute' WHERE tenant_id = current_tenant_id()",
      ),
    );
    const c = company();
    const adapter = createQboAdapter({ env: qboEnv(), fetch: c.fetch, log: () => {} });
    expect(await inA((q) => adapter.ready(q))).toEqual({ ok: true });
    const conn = await inA((q) => loadConnection(q, KEY, { lock: false }));
    expect(conn).toMatchObject({ accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH, expiring: false });
    expect(c.sent.map((s) => new URLSearchParams(s.body ?? "").get("grant_type"))).toEqual(["refresh_token"]);
  });

  it("creates a customer once and finds it by the stored id after that", async () => {
    flags.accountingEnabled = true;
    await inA((q) => saveConnection(q, KEY, { ...mapping, membershipId: A.memberId }));
    const c = company();
    const adapter = createQboAdapter({ env: qboEnv(), fetch: c.fetch, log: () => {} });
    const ctx = { requestId: "0".repeat(32), timeoutMs: 1_000, tenantZone: "America/Chicago" };
    const customer = { id: A.customerId, code: "CUST-1", name: "Test Shipper" };
    const first = await inA((q) => adapter.ensureCustomer(q, customer, ctx));
    const again = await inA((q) => adapter.ensureCustomer(q, customer, ctx));
    expect(again).toEqual(first);
    expect(c.sent.filter((s) => s.method === "POST")).toHaveLength(1);
    expect(JSON.parse(c.sent[1].body ?? "").DisplayName).toMatch(/^QA[0-9A-F] Test Shipper \(CUST-1\)$/);
  });
});
