import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { validated } from "../adapters/tms-source";
import { createSyntheticSource } from "../adapters/tms-source/synthetic";
import { TmsSourceError, type TmsSource } from "../adapters/tms-source/types";
import { appendLine } from "../desk/log";
import { createPgDb } from "../db/pg";
import { splitSql } from "../db/sql-split";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { syntheticLabelMap } from "./status";
import { PARTY_RETRY_MS, pullTms } from "./sync";
import { acceptWakeUp, MAX_WAITING, wakeUpFor, type WakeUp } from "./wakeups";

// The webhook's wake-ups against a fresh database, as the app's role, with a fixed clock passed to
// every call (never the wall clock): the sync reads a waiting wake-up's record first, once for
// three sends, and marks it processed in the transaction that records the read; a repeat during
// the read keeps it waiting; a party wake-up writes the party; another carrier sees none of the
// rows; and 0083's desk_log check upgrade keeps every row already there (a scratch database
// built to 0082 and then upgraded, dropped after, failures included). Only this file's carriers
// are made, removed after.

const savedTms = structuredClone(flags.tmsSync);
const MIN = 60_000;
const NOW = new Date("2026-11-03T15:00:00.000Z");
const MIGRATIONS = join(process.cwd(), "db", "migrations");

let admin: Db;
let app: Db;
const made: Fixture[] = [];

type Carrier = Fixture & { token: string; slug: string };

async function carrier(name: string): Promise<Carrier> {
  const slug = `${name}-${randomUUID().slice(0, 6)}`;
  const f = await makeTenant(admin, slug);
  made.push(f);
  const token = randomUUID();
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO tms_connections (id, tenant_id, system, label_map, lookback_hours, finalize_cooloff_minutes)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'synthetic', CAST($2 AS jsonb), 4, 30)`,
      [randomUUID(), JSON.stringify(syntheticLabelMap())],
    );
    await q.execute(
      `INSERT INTO desk_loops (tenant_id, lease_token, lease_until, updated_at)
       VALUES (current_tenant_id(), CAST($1 AS uuid), CAST('2026-11-30T00:00:00Z' AS timestamptz),
               CAST('2026-10-25T00:00:00Z' AS timestamptz))`,
      [token],
    );
  });
  return { ...f, token, slug };
}

async function ourLoad(f: Carrier, number: string): Promise<string> {
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state,
         dest_city, dest_state, pickup_on, loaded_miles, linehaul_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), 'in_transit', 'Joliet', 'IL',
         'Gary', 'IN', CAST('2026-11-01' AS date), 420, 150000)`,
      [randomUUID(), number, f.customerId, f.driverId],
    ),
  );
  return `syn:${f.slug}:${number}`;
}

// The feed's record reads counted by id; `during` runs inside each record read, as a repeat
// arriving while the sync reads would.
function countingSource(calls: string[], during?: (id: string) => Promise<void>): TmsSource {
  const inner = validated(createSyntheticSource());
  return {
    ...inner,
    readLoad: async (ctx, id) => {
      calls.push(id);
      if (during) await during(id);
      return inner.readLoad(ctx, id);
    },
  };
}

const pull = (f: Carrier, now: Date, source: TmsSource) =>
  pullTms(app, f.session, { token: f.token, now, deadlineMs: now.getTime() + MIN }, { clock: () => now.getTime(), source });

const send = (f: Fixture, w: WakeUp, at: Date) =>
  app.withTenant(f.tenantId, (q) => acceptWakeUp(q, w, { id: randomUUID(), nowIso: at.toISOString(), perMinute: 60 }));

type Row = { external_id: string; sent: number; processed: boolean };
const waiting = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<Row>(
      `SELECT external_id, CAST(sent AS integer) AS sent, (processed_at IS NOT NULL) AS processed
         FROM tms_wakeups WHERE tenant_id = current_tenant_id() ORDER BY received_at, id`,
    ),
  );

beforeAll(() => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl(), max: 3 });
});

afterAll(async () => {
  for (const f of made) await dropTenant(admin, f);
  await app?.close();
  await admin?.close();
});

beforeEach(() => {
  Object.assign(flags.tmsSync, savedTms, { enabled: true, startDate: "2026-10-25" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(flags.tmsSync, savedTms);
  vi.restoreAllMocks();
});

describe("the dispatch webhook's wake-ups", () => {
  it("reads a load sent three times once, first, and marks its one row processed", async () => {
    const f = await carrier("wake-thrice");
    const id = await ourLoad(f, "FL20001");
    // The first pull mirrors it from the list walk.
    await pull(f, NOW, countingSource([]));
    const w: WakeUp = { recordType: "load", externalId: id };
    const at = new Date(NOW.getTime() + MIN);
    expect((await send(f, w, at)).queued).toBe("new");
    expect((await send(f, w, at)).queued).toBe("coalesced");
    expect((await send(f, w, at)).queued).toBe("coalesced");
    expect(await waiting(f)).toEqual([{ external_id: id, sent: 3, processed: false }]);
    const calls: string[] = [];
    const out = await pull(f, new Date(NOW.getTime() + 2 * MIN), countingSource(calls));
    expect(out).toMatchObject({ ran: true, failed: 0 });
    // Read once, by the wake-up (the walk finds it unchanged), and the row is processed.
    expect(calls.filter((c) => c === id)).toEqual([id]);
    expect(calls[0]).toBe(id);
    expect(await waiting(f)).toEqual([{ external_id: id, sent: 3, processed: true }]);
    // A wake-up after that is a new row, read on the next pass.
    expect((await send(f, w, new Date(NOW.getTime() + 3 * MIN))).queued).toBe("new");
    expect((await waiting(f)).map((r) => r.processed)).toEqual([true, false]);
  });

  it("keeps a wake-up waiting when it is sent again while its record is read", async () => {
    const f = await carrier("wake-race");
    const id = await ourLoad(f, "FL20002");
    await pull(f, NOW, countingSource([]));
    const w: WakeUp = { recordType: "load", externalId: id };
    await send(f, w, new Date(NOW.getTime() + MIN));
    let repeated = false;
    const calls: string[] = [];
    const source = countingSource(calls, async (read) => {
      if (read !== id || repeated) return;
      repeated = true;
      expect((await send(f, w, new Date(NOW.getTime() + 2 * MIN))).queued).toBe("coalesced");
    });
    await pull(f, new Date(NOW.getTime() + 2 * MIN), source);
    expect(await waiting(f)).toEqual([{ external_id: id, sent: 2, processed: false }]);
    // The next pass reads it again, and this time it is processed.
    const again: string[] = [];
    await pull(f, new Date(NOW.getTime() + 3 * MIN), countingSource(again));
    expect(again.filter((c) => c === id)).toEqual([id]);
    expect(await waiting(f)).toEqual([{ external_id: id, sent: 2, processed: true }]);
  });

  it("writes a customer a wake-up names, and marks a party the feed does not know as processed", async () => {
    const f = await carrier("wake-party");
    await send(f, { recordType: "customer", externalId: "CUST-1" }, NOW);
    await send(f, { recordType: "customer", externalId: "CUST-404" }, NOW);
    const out = await pull(f, new Date(NOW.getTime() + MIN), countingSource([]));
    expect(out).toMatchObject({ ran: true, failed: 0 });
    const parties = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ kind: string; external_id: string; name: string; customer_id: string | null }>(
        `SELECT kind, external_id, name, CAST(customer_id AS text) AS customer_id FROM tms_parties
          WHERE tenant_id = current_tenant_id() ORDER BY external_id`,
      ),
    );
    expect(parties).toEqual([{ kind: "customer", external_id: "CUST-1", name: "Test Shipper", customer_id: f.customerId }]);
    // Both were received at the same instant, so they are sorted here by the id they name.
    const rows = (await waiting(f)).map((r) => [r.external_id, r.processed]);
    expect(rows.sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([
      ["CUST-1", true],
      ["CUST-404", true],
    ]);
  });

  it("keeps a party wake-up waiting while its read fails, and marks it once it is an hour old", async () => {
    const f = await carrier("wake-party-fail");
    await send(f, { recordType: "driver", externalId: "DRV-9" }, NOW);
    const failing: TmsSource = {
      ...countingSource([]),
      readParty: async () => {
        throw new TmsSourceError("server_error");
      },
    };
    const first = await pull(f, new Date(NOW.getTime() + MIN), failing);
    expect(first).toMatchObject({ ran: true, failed: 1 });
    expect(await waiting(f)).toEqual([{ external_id: "DRV-9", sent: 1, processed: false }]);
    await pull(f, new Date(NOW.getTime() + PARTY_RETRY_MS), failing);
    expect(await waiting(f)).toEqual([{ external_id: "DRV-9", sent: 1, processed: true }]);
  });

  it("does not take a wake-up past the carrier's waiting cap, and coalesces the same one still", async () => {
    const f = await carrier("wake-cap");
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `INSERT INTO tms_wakeups (id, tenant_id, record_type, external_id, received_at)
         SELECT gen_random_uuid(), current_tenant_id(), 'load', 'cap-' || n, CAST($1 AS timestamptz)
           FROM generate_series(1, $2) AS n`,
        [NOW.toISOString(), MAX_WAITING],
      ),
    );
    const q = (fn: (q: Queryable) => Promise<unknown>) => app.withTenant(f.tenantId, fn);
    expect(await q((x) => wakeUpFor(x, { recordType: "load", externalId: "cap-new" }, { id: randomUUID(), nowIso: NOW.toISOString() }))).toBe("full");
    expect(await q((x) => wakeUpFor(x, { recordType: "load", externalId: "cap-1" }, { id: randomUUID(), nowIso: NOW.toISOString() }))).toBe("coalesced");
  });

  it("keeps each carrier's wake-ups and minute counts to itself", async () => {
    const a = await carrier("wake-rls-a");
    const b = await carrier("wake-rls-b");
    await send(a, { recordType: "load", externalId: "syn:a:FL1" }, NOW);
    const seen = await app.withTenant(b.tenantId, async (q) => ({
      wakeups: await q.query<{ n: number }>("SELECT CAST(count(*) AS integer) AS n FROM tms_wakeups"),
      minutes: await q.query<{ n: number }>("SELECT CAST(count(*) AS integer) AS n FROM tms_hook_minutes"),
    }));
    expect(seen).toEqual({ wakeups: [{ n: 0 }], minutes: [{ n: 0 }] });
    // B cannot write a row in A's name, nor change A's.
    expect(
      await sqlStateOf(
        app.withTenant(b.tenantId, (q) =>
          q.execute(
            `INSERT INTO tms_wakeups (id, tenant_id, record_type, external_id, received_at)
             VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'load', 'syn:a:FL2', CAST($3 AS timestamptz))`,
            [randomUUID(), a.tenantId, NOW.toISOString()],
          ),
        ),
      ),
    ).toBe("42501");
    expect(await app.withTenant(b.tenantId, (q) => q.execute("UPDATE tms_wakeups SET processed_at = now()"))).toBe(0);
    expect(await waiting(a)).toEqual([{ external_id: "syn:a:FL1", sent: 1, processed: false }]);
  });
});

// The upgrade: a scratch database built from every migration before 0083, desk_log rows by both
// old wakers, then 0083 and its _validate file applied the way the runner does (one transaction
// per file). Dropped after, failures included.
describe("0083's desk_log waker check, upgraded over rows already there", () => {
  const NAME = `payday_up83_${randomBytes(4).toString("hex")}`;
  const server = new URL(adminUrl());
  let scratch: Db | undefined;

  const onServer = async (sql: string) => {
    if (!/^payday_up83_[a-f0-9]{8}$/.test(NAME)) throw new Error("not this test's database");
    const client = new Client({ connectionString: server.toString() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  const apply = async (db: Db, file: string) => {
    const statements = splitSql(readFileSync(join(MIGRATIONS, file), "utf8"));
    await db.withoutTenant(async (q) => {
      for (const s of statements) await q.execute(s);
    });
  };

  beforeAll(async () => {
    await onServer(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await onServer(`CREATE DATABASE ${NAME}`);
    const url = new URL(server);
    url.pathname = `/${NAME}`;
    scratch = createPgDb({ connectionString: url.toString(), max: 1 });
  }, 60_000);

  afterAll(async () => {
    await scratch?.close();
    await onServer(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
  }, 60_000);

  it("keeps the old wakers' rows, validates the check, takes the webhook and refuses any other", async () => {
    const db = scratch!;
    const files = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();
    for (const file of files.filter((n) => n < "0083")) await apply(db, file);
    const tenant = randomUUID();
    const line = (by: "schedule" | "button" | "webhook") => ({
      id: randomUUID(),
      wakeId: randomUUID(),
      at: NOW.toISOString(),
      kind: "wake" as const,
      eventKey: null,
      source: null,
      subjectId: null,
      by,
      detail: {},
    });
    await db.withTenant(tenant, async (q) => {
      await q.execute(
        "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, 'Upgrade Freight', 'America/Chicago')",
        [`up83-${tenant.slice(0, 8)}`],
      );
      await appendLine(q, line("schedule"));
      await appendLine(q, line("button"));
    });
    // Before 0083 the webhook is not a waker.
    expect(await sqlStateOf(db.withTenant(tenant, (q) => appendLine(q, line("webhook"))))).toBe("23514");
    await apply(db, "0083_tms_wakeups.sql");
    await apply(db, "0083_tms_wakeups_validate.sql");
    const [check] = await db.withoutTenant((q) =>
      q.query<{ convalidated: boolean; def: string }>(
        `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = CAST('public.desk_log' AS regclass) AND conname = 'desk_log_by_check'`,
      ),
    );
    expect(check.convalidated).toBe(true);
    expect(check.def).toContain("webhook");
    const kept = await db.withTenant(tenant, (q) => q.query<{ by: string }>("SELECT by FROM desk_log ORDER BY by"));
    expect(kept.map((r) => r.by)).toEqual(["button", "schedule"]);
    await db.withTenant(tenant, (q) => appendLine(q, line("webhook")));
    expect(
      await sqlStateOf(
        db.withTenant(tenant, (q) =>
          q.execute(
            `INSERT INTO desk_log (id, tenant_id, wake_id, at, kind, by, detail)
             VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS timestamptz), 'wake', 'email', CAST('{}' AS jsonb))`,
            [randomUUID(), randomUUID(), NOW.toISOString()],
          ),
        ),
      ),
    ).toBe("23514");
    const tables = await db.withoutTenant((q) =>
      q.query<{ name: string }>(
        "SELECT relname AS name FROM pg_class WHERE relname IN ('tms_wakeups', 'tms_hook_minutes') AND relforcerowsecurity ORDER BY 1",
      ),
    );
    expect(tables.map((t) => t.name)).toEqual(["tms_hook_minutes", "tms_wakeups"]);
  }, 120_000);
});
