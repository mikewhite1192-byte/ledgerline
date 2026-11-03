import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import { createPgDb } from "@/lib/db/pg";
import { adminUrl, appUrl } from "@/lib/db/test-urls";
import type { Db } from "@/lib/db/types";
import { dropTenant, makeTenant, type Fixture } from "@/lib/money/test-db";
import { forgetTmsHookKey } from "@/lib/tms/hook-key";
import { POST } from "./route";

// The dispatch webhook against a real database, as the app's own role, with the clock fixed (only
// Date is faked, never the wall clock): the same wake-up sent three times is one row (the dedupe
// key tms_wakeups_one_waiting), the 61st call in one minute is 429 with the row still one, a wake
// while another holds the desk's lease writes no desk line and leaves the lease as it was, and a
// wrong token touches nothing. Every carrier made here is removed after each test.

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => holder.db,
}));

const KEY = "Tq4".repeat(16);
const NOW = Date.parse("2026-11-03T15:00:10.000Z");
const saved = structuredClone(flags);
const savedKey = process.env.TMS_HOOK_KEY;
let admin: Db;
let app: Db;
let A: Fixture | undefined;

const post = (tenant: string, body: unknown, token = KEY) =>
  POST(
    new Request(`https://app.example/api/internal/tms-hook/${tenant}?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ tenant }) },
  );

const LOAD = { recordType: "load", externalId: "syn:hook-test:FL1" };

type Row = { record_type: string; external_id: string; sent: number; processed: boolean };
const rows = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<Row>(
      `SELECT record_type, external_id, CAST(sent AS integer) AS sent, (processed_at IS NOT NULL) AS processed
         FROM tms_wakeups WHERE tenant_id = current_tenant_id() ORDER BY received_at, id`,
    ),
  );
const minutes = (f: Fixture) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<{ minute: string; accepted: number }>(
      `SELECT to_char(minute_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS minute, accepted
         FROM tms_hook_minutes WHERE tenant_id = current_tenant_id() ORDER BY minute_at`,
    ),
  );

describe("POST /api/internal/tms-hook/[tenant] (database)", () => {
  beforeAll(() => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    holder.db = app;
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    Object.assign(flags, structuredClone(saved));
    flags.tmsHook.enabled = true;
    flags.tmsSync.enabled = true;
    // Off unless a test turns it on: the wake answers disabled and touches nothing.
    flags.deskLoop.enabled = false;
    process.env.TMS_HOOK_KEY = KEY;
    forgetTmsHookKey();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    A = await makeTenant(admin, `hook-test-${randomUUID().slice(0, 8)}`);
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES
           (current_tenant_id(), 'service:sweep:' || CAST(current_tenant_id() AS text), 'sweep@hook-test.invalid', 'staff')`,
      ),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    Object.assign(flags, structuredClone(saved));
    if (savedKey === undefined) delete process.env.TMS_HOOK_KEY;
    else process.env.TMS_HOOK_KEY = savedKey;
    forgetTmsHookKey();
    vi.restoreAllMocks();
    if (A) await dropTenant(admin, A);
    A = undefined;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("keeps one row for the same wake-up sent three times while it waits", async () => {
    const f = A!;
    const answers: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await post(f.tenantId, LOAD);
      expect(res.status).toBe(202);
      answers.push(await res.json());
    }
    expect(answers).toEqual([
      { queued: "new", wake: "disabled" },
      { queued: "coalesced", wake: "disabled" },
      { queued: "coalesced", wake: "disabled" },
    ]);
    expect(await rows(f)).toEqual([{ record_type: "load", external_id: LOAD.externalId, sent: 3, processed: false }]);
    // Another record is its own row.
    expect((await post(f.tenantId, { recordType: "customer", externalId: "CUST-1" })).status).toBe(202);
    expect(await rows(f)).toHaveLength(2);
  });

  it("answers 429 to the 61st call in one minute, still one row, and takes calls again the next minute", async () => {
    const f = A!;
    for (let i = 0; i < 60; i += 1) {
      expect((await post(f.tenantId, LOAD)).status, `call ${i + 1}`).toBe(202);
    }
    const over = await post(f.tenantId, LOAD);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited", retryable: true });
    const kept = await rows(f);
    expect(kept).toHaveLength(1);
    expect(kept[0].sent).toBe(61);
    expect(await minutes(f)).toEqual([{ minute: "2026-11-03T15:00:00", accepted: 60 }]);
    vi.setSystemTime(NOW + 60_000);
    expect((await post(f.tenantId, LOAD)).status).toBe(202);
    // The earlier minute's row is gone; the new minute counts from one.
    expect(await minutes(f)).toEqual([{ minute: "2026-11-03T15:01:00", accepted: 1 }]);
    expect(await rows(f)).toHaveLength(1);
  });

  it("does not double a wake already in progress: busy, no desk line, the lease as it was", async () => {
    const f = A!;
    flags.deskLoop.enabled = true;
    const holderToken = randomUUID();
    await admin.withTenant(f.tenantId, (q) =>
      q.execute(
        `INSERT INTO desk_loops (tenant_id, lease_token, lease_until, updated_at)
         VALUES (current_tenant_id(), CAST($1 AS uuid), CAST('2026-11-03T15:05:00Z' AS timestamptz),
                 CAST('2026-11-03T15:00:00Z' AS timestamptz))`,
        [holderToken],
      ),
    );
    const res = await post(f.tenantId, LOAD);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: "new", wake: "busy" });
    const [lease] = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ token: string; until: string }>(
        `SELECT CAST(lease_token AS text) AS token, to_char(lease_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS until
           FROM desk_loops WHERE tenant_id = current_tenant_id()`,
      ),
    );
    expect(lease).toEqual({ token: holderToken, until: "2026-11-03T15:05:00" });
    const [log] = await admin.withTenant(f.tenantId, (q) =>
      q.query<{ n: number }>("SELECT CAST(count(*) AS integer) AS n FROM desk_log WHERE tenant_id = current_tenant_id()"),
    );
    expect(log.n).toBe(0);
    // The wake-up waits for the wake that holds the lease, or the next one.
    expect(await rows(f)).toEqual([{ record_type: "load", external_id: LOAD.externalId, sent: 1, processed: false }]);
  });

  it("touches nothing on a wrong token, a missing key or a switch off", async () => {
    const f = A!;
    expect((await post(f.tenantId, LOAD, "Wr0".repeat(16))).status).toBe(403);
    delete process.env.TMS_HOOK_KEY;
    forgetTmsHookKey();
    expect((await post(f.tenantId, LOAD)).status).toBe(503);
    process.env.TMS_HOOK_KEY = KEY;
    forgetTmsHookKey();
    flags.tmsHook.enabled = false;
    expect((await post(f.tenantId, LOAD)).status).toBe(409);
    flags.tmsHook.enabled = true;
    flags.tmsSync.enabled = false;
    expect((await post(f.tenantId, LOAD)).status).toBe(409);
    expect(await rows(f)).toEqual([]);
    expect(await minutes(f)).toEqual([]);
  });
});
