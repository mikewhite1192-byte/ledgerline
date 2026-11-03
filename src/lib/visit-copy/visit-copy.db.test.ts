import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { reserve, settle, type Reservation } from "../ai/spend";
import { visitSub, type Session } from "../auth/claims";
import {
  chargeVisit,
  claimCopy,
  countVisitTurn,
  markCopyReady,
  readVisit,
  startVisit,
  type VisitLimits,
} from "../auth/demo-visit";
import { countTenantRows } from "../data/read";
import { TENANT_TABLES } from "../data/tables";
import { WIPE_MARK_SQL } from "../data/writer";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { HERO_OPEN_WEEK } from "../seed/assert-plan";
import { DEMO_CARRIERS } from "../seed/carriers";
import golden from "../seed/golden.json";
import { DEMO_ANCHOR } from "../seed/anchor";
import { demoCarrierOf, demoTemplateOf, heroNet } from "../seed/reset";
import { countRows } from "../seed/summary";
import { buildCopySlice, copyPlan, copySlug, templatePlan, type CopyTarget } from "./build";
import { NotACopy, purgeCopy, purgeExpired } from "./purge";
import { VISIT_EMAIL } from "./visitor";

// A visit's own copy of a demo carrier against a real, freshly migrated database, as the app's
// role: migration 0091's grants and checks, a whole copy built in slices (its counts are the
// seed's golden counts, the hero's open-week net is the worked example), the copy's own visit row
// charged and counted while the demo carrier's ticket stays untouched, two copies and the demo
// carrier walled off from each other, and the purge (only an ended copy goes, the others stay
// whole, and the model call totals move onto ops.ai_spend's purged columns so I4 still balances).
// The build time is measured and printed. The spend counters are global, so this file puts them
// back as it found them.

const HOME = randomUUID();
const OTHER = randomUUID(); // a carrier of its own, never a copy
const tag = HOME.slice(0, 8);
const JUDGE = `judge-${HOME}`;
const template = DEMO_CARRIERS[0];

const LIMITS: VisitLimits = {
  sessionCapCents: 1,
  turnsPerSession: 2,
  dayCapCents: 2,
  sessionsPerIpPerHour: 10,
  sessionsPerHour: 10,
  sessionsPerDay: 10,
  cookieHours: 2,
};
const H1 = "1".repeat(64);
const CENT = 1_000_000_000;

let admin: Db;
let app: Db;
const savedJudge = { ...flags.judgeAccess };

type Ticket = { id: string; copy: CopyTarget };
let A: Ticket;
let B: Ticket;
const built: string[] = [];

const COUNTER_COLUMNS = [
  "spent_nanocents",
  "reserved_nanocents",
  "calls",
  "wonder_spent_nanocents",
  "wonder_reserved_nanocents",
  "purged_spent_nanocents",
  "purged_reserved_nanocents",
  "purged_calls",
  "purged_wonder_spent_nanocents",
  "purged_wonder_reserved_nanocents",
] as const;
let counters: Record<(typeof COUNTER_COLUMNS)[number], string> | undefined;

async function readCounters() {
  const rows = await admin.withoutTenant((q) =>
    q.query<Record<(typeof COUNTER_COLUMNS)[number], string>>(
      `SELECT ${COUNTER_COLUMNS.map((c) => `CAST(${c} AS text) AS ${c}`).join(", ")} FROM ops.ai_spend WHERE id = 1`,
    ),
  );
  return rows[0];
}

// counter minus log minus purged, per I4 column: the purge must leave every one where it was.
async function i4Gaps() {
  const rows = await admin.withoutTenant((q) =>
    q.query<{ spent: string; reserved: string; calls: string }>(
      `SELECT CAST(s.spent_nanocents - l.spent - s.purged_spent_nanocents AS text) AS spent,
              CAST(s.reserved_nanocents - l.reserved - s.purged_reserved_nanocents AS text) AS reserved,
              CAST(s.calls - l.settled - s.purged_calls AS text) AS calls
         FROM ops.ai_spend s,
              (SELECT COALESCE(SUM(cost_nanocents), 0) AS spent,
                      COALESCE(SUM(reserved_nanocents) FILTER (WHERE status IN ('reserved', 'unknown')), 0) AS reserved,
                      count(*) FILTER (WHERE status <> 'reserved') AS settled
                 FROM model_calls) l
        WHERE s.id = 1`,
    ),
  );
  return rows[0];
}

async function newTicket(): Promise<Ticket> {
  const started = await app.withTenant(HOME, (q) =>
    startVisit(q, { sub: JUDGE, ipHash: H1, reuseId: null, limits: LIMITS }),
  );
  if (!started.ok) throw new Error("the visit did not start");
  const copyTenantId = randomUUID();
  const copySessionId = randomUUID();
  const claim = await app.withTenant(HOME, (q) =>
    claimCopy(q, { visitId: started.id, sub: JUDGE, copyTenantId, copySessionId }),
  );
  expect(claim).toBe("claimed");
  const read = await app.withTenant(HOME, (q) => readVisit(q, JUDGE, started.id));
  if (!read.copy) throw new Error("the claim was not read back");
  built.push(copyTenantId);
  return {
    id: started.id,
    copy: { ticketId: started.id, copyTenantId, copySessionId, expiresAt: read.copy.expiresAt, template },
  };
}

// Every slice until done, as the preparing page calls them.
async function buildWhole(target: CopyTarget, sliceMs: number) {
  const started = performance.now();
  let slices = 0;
  let statements = 0;
  for (;;) {
    const r = await buildCopySlice(app, target, { sliceMs });
    slices += 1;
    statements += r.statements;
    expect(r.setup).toBe(slices === 1);
    if (r.done) break;
    if (slices > TENANT_TABLES.length + 1) throw new Error("the build does not finish");
  }
  return { slices, statements, ms: Math.round(performance.now() - started) };
}

const copySession = (t: Ticket): Session => ({
  sub: visitSub(t.id),
  email: "judge@blueridge.example",
  tenantId: t.copy.copyTenantId,
  demoSessionId: t.copy.copySessionId,
  visitTicketId: t.id,
});

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl(), max: 2 });
  app = createPgDb({ connectionString: appUrl(), max: 2 });
  Object.assign(flags.judgeAccess, { enabled: true, ...LIMITS });
  counters = await readCounters();
  for (const [id, slug] of [
    [HOME, `vc-home-${tag}`],
    [OTHER, `vc-other-${tag}`],
  ]) {
    await admin.withTenant(id, async (q) => {
      await q.execute(
        "INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, 'America/New_York')",
        [slug, `Carrier ${slug}`],
      );
    });
  }
  await admin.withTenant(HOME, (q) =>
    q.execute(
      "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'judge')",
      [JUDGE, `judge@vc-${tag}.example`],
    ),
  );
  A = await newTicket();
  B = await newTicket();
}, 60_000);

afterAll(async () => {
  Object.assign(flags.judgeAccess, savedJudge);
  if (counters) {
    const saved = counters;
    await admin.withoutTenant((q) =>
      q.execute(
        `UPDATE ops.ai_spend SET ${COUNTER_COLUMNS.map((c, i) => `${c} = CAST($${i + 1} AS bigint)`).join(", ")} WHERE id = 1`,
        COUNTER_COLUMNS.map((c) => saved[c]),
      ),
    );
  }
  for (const id of [...built, HOME, OTHER]) {
    await admin?.withTenant(id, async (q) => {
      await q.query(WIPE_MARK_SQL, []);
      await q.execute("DELETE FROM tenants WHERE id = current_tenant_id()");
    });
  }
  await app?.close();
  await admin?.close();
});

describe("migration 0091", () => {
  it("lets the app set only the copy columns on a visit, besides what 0043 allowed", async () => {
    for (const sql of [
      "UPDATE demo_sessions SET ip_hash = NULL WHERE id = CAST($1 AS uuid)",
      "UPDATE demo_sessions SET cognito_sub = 'someone' WHERE id = CAST($1 AS uuid)",
      "UPDATE demo_sessions SET created_at = now() WHERE id = CAST($1 AS uuid)",
      "UPDATE demo_sessions SET tenant_id = tenant_id WHERE id = CAST($1 AS uuid)",
    ]) {
      await expect(app.withTenant(HOME, (q) => q.execute(sql, [A.id])), sql).rejects.toThrow();
    }
    await expect(
      app.withTenant(HOME, (q) =>
        q.execute("UPDATE demo_sessions SET copy_deleted_at = copy_deleted_at WHERE id = CAST($1 AS uuid)", [A.id]),
      ),
    ).resolves.toBe(1);
  });

  it("keeps a copy's two ids together, and ready only with a copy", async () => {
    await expect(
      admin.withTenant(HOME, (q) =>
        q.execute("UPDATE demo_sessions SET copy_session_id = NULL WHERE id = CAST($1 AS uuid)", [A.id]),
      ),
    ).rejects.toThrow();
    const lone = await app.withTenant(HOME, (q) =>
      startVisit(q, { sub: JUDGE, ipHash: H1, reuseId: null, limits: LIMITS }),
    );
    if (!lone.ok) throw new Error("the visit did not start");
    await expect(
      admin.withTenant(HOME, (q) =>
        q.execute("UPDATE demo_sessions SET copy_ready_at = now() WHERE id = CAST($1 AS uuid)", [lone.id]),
      ),
    ).rejects.toThrow();
    await expect(
      admin.withTenant(HOME, (q) => q.execute("UPDATE tenants SET demo_copy_of = 'Not A Slug!' WHERE id = current_tenant_id()")),
    ).rejects.toThrow();
  });

  it("claims a visit's copy once: a second claim keeps the first", async () => {
    const again = await app.withTenant(HOME, (q) =>
      claimCopy(q, { visitId: A.id, sub: JUDGE, copyTenantId: randomUUID(), copySessionId: randomUUID() }),
    );
    expect(again).toBe("kept");
    const read = await app.withTenant(HOME, (q) => readVisit(q, JUDGE, A.id));
    expect(read.copy?.tenantId).toBe(A.copy.copyTenantId);
    // Another login's claim on this visit is refused.
    const other = await app.withTenant(HOME, (q) =>
      claimCopy(q, { visitId: A.id, sub: "someone-else", copyTenantId: randomUUID(), copySessionId: randomUUID() }),
    );
    expect(other).toBe("refused");
  });
});

describe("building a copy", () => {
  it("builds copy A in slices to the golden counts and the hero's worked example, and prints the time", async () => {
    const run = await buildWhole(A.copy, flags.visitCopies.sliceMs);
    console.info(
      `visit copy build ${template.slug}: ${run.slices} slices, ${run.statements} statements, ${run.ms} ms (local Postgres)`,
    );
    const counts = await app.withTenant(A.copy.copyTenantId, (q) => countTenantRows(q));
    const goldenCounts = (golden.carriers as Record<string, { counts: Record<string, number> }>)[template.slug].counts;
    expect(golden.anchor).toBe(DEMO_ANCHOR);
    for (const t of TENANT_TABLES) expect(counts[t], t).toBe(goldenCounts[t] ?? 0);
    expect(counts).toEqual(countRows(templatePlan(template).rows));
    const net = await app.withTenant(A.copy.copyTenantId, (q) => heroNet(q, copyPlan(template, A.copy.copyTenantId)));
    expect(net).toBe(HERO_OPEN_WEEK.netCents);
    // A slice after the copy is whole changes nothing.
    const after = await buildCopySlice(app, A.copy, { sliceMs: 1 });
    expect(after).toMatchObject({ done: true, setup: false, tablesDone: TENANT_TABLES.length });
    expect(await app.withTenant(A.copy.copyTenantId, (q) => countTenantRows(q))).toEqual(counts);
    expect(await app.withTenant(HOME, (q) => markCopyReady(q, { visitId: A.id, sub: JUDGE, copyTenantId: A.copy.copyTenantId }))).toBe(true);
    expect(await app.withTenant(HOME, (q) => markCopyReady(q, { visitId: A.id, sub: JUDGE, copyTenantId: A.copy.copyTenantId }))).toBe(true);
    const read = await app.withTenant(HOME, (q) => readVisit(q, JUDGE, A.id));
    expect(read.copy).toMatchObject({ ready: true, deleted: false });
  }, 120_000);

  it("builds copy B one table a slice, picking up where each slice stopped", async () => {
    const run = await buildWhole(B.copy, 1);
    console.info(`visit copy build ${template.slug}, one table a slice: ${run.slices} slices, ${run.ms} ms`);
    expect(run.slices).toBeGreaterThan(1);
    expect(await app.withTenant(B.copy.copyTenantId, (q) => countTenantRows(q))).toEqual(
      countRows(templatePlan(template).rows),
    );
  }, 120_000);

  it("is a carrier of its own built from the demo carrier: its slug, demo_copy_of, the logins and the visit row", async () => {
    const tenant = await app.withTenant(A.copy.copyTenantId, (q) =>
      q.query<{ slug: string; name: string; timezone: string; demo_copy_of: string }>(
        "SELECT slug, name, timezone, demo_copy_of FROM tenants WHERE id = current_tenant_id()",
      ),
    );
    expect(tenant).toEqual([
      { slug: copySlug(template, A.copy.copyTenantId), name: template.name, timezone: template.timezone, demo_copy_of: template.slug },
    ]);
    expect(await app.withTenant(A.copy.copyTenantId, (q) => demoTemplateOf(q))).toBe(template);
    // The demo reset and the fleet move keep the exact match: a copy is never reset.
    expect(await app.withTenant(A.copy.copyTenantId, (q) => demoCarrierOf(q))).toBeNull();
    const members = await app.withTenant(A.copy.copyTenantId, (q) =>
      q.query<{ cognito_sub: string; email: string; role: string }>(
        "SELECT cognito_sub, email, role FROM memberships ORDER BY cognito_sub",
      ),
    );
    expect(members).toEqual([
      { cognito_sub: `service:autopilot:${A.copy.copyTenantId}`, email: `autopilot@${copySlug(template, A.copy.copyTenantId)}.invalid`, role: "staff" },
      { cognito_sub: `service:sweep:${A.copy.copyTenantId}`, email: `sweep@${copySlug(template, A.copy.copyTenantId)}.invalid`, role: "staff" },
      { cognito_sub: visitSub(A.id), email: VISIT_EMAIL, role: "admin" },
    ]);
    const visits = await app.withTenant(A.copy.copyTenantId, (q) =>
      q.query<{ id: string; cognito_sub: string }>("SELECT id, cognito_sub FROM demo_sessions"),
    );
    expect(visits).toEqual([{ id: A.copy.copySessionId, cognito_sub: visitSub(A.id) }]);
    // The copy's visit row ends when the visit does.
    const ends = await admin.withoutTenant((q) =>
      q.query<{ same: boolean }>(
        `SELECT c.expires_at = h.expires_at AS same FROM demo_sessions c, demo_sessions h
          WHERE c.id = CAST($1 AS uuid) AND h.id = CAST($2 AS uuid)`,
        [A.copy.copySessionId, A.id],
      ),
    );
    expect(ends).toEqual([{ same: true }]);
  });
});

describe("a copy's visit row", () => {
  it("charges, settles and counts turns on the copy's own row, leaving the demo carrier's ticket alone", async () => {
    const s = copySession(A);
    const now = new Date().toISOString();
    const r: Reservation = {
      callId: randomUUID(),
      target: "spark",
      provider: "meta",
      model: "muse-spark-1.3",
      kind: "text",
      purpose: "proof",
      reasoningEffort: "low",
      traceId: null,
      reserveNanocents: CENT / 2,
      capNanocents: Number.MAX_SAFE_INTEGER,
      wonderCapNanocents: null,
      jobCapNanocents: Number.MAX_SAFE_INTEGER,
      at: now,
    };
    await reserve(app, s, r);
    expect(
      await settle(app, s, r.callId, {
        kind: "answered",
        status: "ok",
        usage: { input: 10, cached: 0, output: 20, reasoning: 0 },
        units: null,
        costNanocents: CENT / 4,
        upstreamId: "resp_copy",
        httpStatus: 200,
        durationMs: 100,
      }),
    ).toBe(true);
    // chargeVisit directly: the copy's row takes it, within its own cap.
    expect(
      await app.withTenant(s.tenantId, (q) =>
        chargeVisit(q, { visitId: s.demoSessionId!, sub: s.sub, nanocents: 1, limits: LIMITS, at: now }),
      ),
    ).toBe(true);
    expect(
      await app.withTenant(s.tenantId, (q) =>
        countVisitTurn(q, { visitId: s.demoSessionId!, sub: s.sub, turnsPerSession: LIMITS.turnsPerSession, at: now }),
      ),
    ).toBe("ok");
    const copyRow = await app.withTenant(s.tenantId, (q) =>
      q.query<{ spent: string; reserved: string; turns: number }>(
        "SELECT CAST(spent_nanocents AS text) AS spent, CAST(reserved_nanocents AS text) AS reserved, turns FROM demo_sessions",
      ),
    );
    expect(copyRow).toEqual([{ spent: String(CENT / 4), reserved: "1", turns: 1 }]);
    const ticket = await app.withTenant(HOME, (q) =>
      q.query<{ spent: string; reserved: string; turns: number }>(
        `SELECT CAST(spent_nanocents AS text) AS spent, CAST(reserved_nanocents AS text) AS reserved, turns
           FROM demo_sessions WHERE id = CAST($1 AS uuid)`,
        [A.id],
      ),
    );
    expect(ticket).toEqual([{ spent: "0", reserved: "0", turns: 0 }]);
    // The model call is logged in the copy, under the copy's tenant.
    const calls = await app.withTenant(s.tenantId, (q) => q.query("SELECT id FROM model_calls"));
    expect(calls).toHaveLength(1);
  });
});

describe("isolation", () => {
  it("walls the two copies and the demo carrier off from each other", async () => {
    const want = countRows(templatePlan(template).rows);
    for (const t of [A, B]) {
      const seen = await app.withTenant(t.copy.copyTenantId, (q) =>
        q.query<{ drivers: string; visits: string; tenants: string }>(
          `SELECT (SELECT CAST(count(*) AS text) FROM drivers) AS drivers,
                  (SELECT CAST(count(*) AS text) FROM demo_sessions) AS visits,
                  (SELECT CAST(count(*) AS text) FROM tenants) AS tenants`,
        ),
      );
      expect(seen).toEqual([{ drivers: String(want.drivers), visits: "1", tenants: "1" }]);
    }
    const home = await app.withTenant(HOME, (q) =>
      q.query<{ drivers: string; copies: string }>(
        `SELECT (SELECT CAST(count(*) AS text) FROM drivers) AS drivers,
                (SELECT CAST(count(*) AS text) FROM demo_sessions WHERE id IN (CAST($1 AS uuid), CAST($2 AS uuid))) AS copies`,
        [A.copy.copySessionId, B.copy.copySessionId],
      ),
    );
    expect(home).toEqual([{ drivers: "0", copies: "0" }]);
    // No id is shared between the copies.
    const shared = await admin.withoutTenant((q) =>
      q.query<{ n: string }>(
        `SELECT CAST(count(*) AS text) AS n FROM drivers a JOIN drivers b ON a.id = b.id
          WHERE a.tenant_id = CAST($1 AS uuid) AND b.tenant_id = CAST($2 AS uuid)`,
        [A.copy.copyTenantId, B.copy.copyTenantId],
      ),
    );
    expect(shared).toEqual([{ n: "0" }]);
    // Copy B cannot see copy A's model call.
    expect(await app.withTenant(B.copy.copyTenantId, (q) => q.query("SELECT id FROM model_calls"))).toEqual([]);
  });
});

describe("the purge", () => {
  it("refuses the demo carrier itself and a carrier that is not a copy, deleting nothing", async () => {
    await expect(purgeCopy(app, HOME, { visitId: A.id, copyTenantId: HOME })).rejects.toThrow(NotACopy);
    await expect(purgeCopy(app, HOME, { visitId: A.id, copyTenantId: OTHER })).rejects.toThrow(NotACopy);
    const left = await admin.withoutTenant((q) =>
      q.query("SELECT id FROM tenants WHERE id IN (CAST($1 AS uuid), CAST($2 AS uuid))", [HOME, OTHER]),
    );
    expect(left).toHaveLength(2);
  });

  it("deletes only an ended copy past the grace, moves its call totals to the purged columns and keeps I4 even", async () => {
    // Nothing has ended yet.
    expect(await purgeExpired(app, HOME, { graceMinutes: 60, limit: 5 })).toEqual({ purged: 0, gone: 0, failed: 0 });
    await admin.withTenant(HOME, (q) =>
      q.execute(`UPDATE demo_sessions SET created_at = now() - interval '3 hours', expires_at = now() - interval '61 minutes'
          WHERE id = CAST($1 AS uuid)`, [A.id]),
    );
    const gapsBefore = await i4Gaps();
    const before = await readCounters();
    expect(await purgeExpired(app, HOME, { graceMinutes: 60, limit: 5 })).toEqual({ purged: 1, gone: 0, failed: 0 });
    const after = await readCounters();
    expect(BigInt(after.purged_spent_nanocents) - BigInt(before.purged_spent_nanocents)).toBe(BigInt(CENT / 4));
    expect(BigInt(after.purged_calls) - BigInt(before.purged_calls)).toBe(1n);
    expect(after.spent_nanocents).toBe(before.spent_nanocents);
    expect(await i4Gaps()).toEqual(gapsBefore);

    const gone = await admin.withoutTenant((q) =>
      q.query("SELECT id FROM tenants WHERE id = CAST($1 AS uuid)", [A.copy.copyTenantId]),
    );
    expect(gone).toEqual([]);
    const rowsLeft = await admin.withoutTenant((q) =>
      q.query<{ n: string }>("SELECT CAST(count(*) AS text) AS n FROM drivers WHERE tenant_id = CAST($1 AS uuid)", [
        A.copy.copyTenantId,
      ]),
    );
    expect(rowsLeft).toEqual([{ n: "0" }]);
    // The ticket says so, and reads as an ended visit with a purged copy.
    const read = await app.withTenant(HOME, (q) => readVisit(q, JUDGE, A.id));
    expect(read).toMatchObject({ live: false, copy: { deleted: true } });
    // Copy B is whole.
    expect(await app.withTenant(B.copy.copyTenantId, (q) => countTenantRows(q))).toEqual(
      countRows(templatePlan(template).rows),
    );
    // A second purge finds nothing to do.
    expect(await purgeExpired(app, HOME, { graceMinutes: 60, limit: 5 })).toEqual({ purged: 0, gone: 0, failed: 0 });
    // A copy already deleted is "gone" and only marks its ticket.
    expect(await purgeCopy(app, HOME, { visitId: A.id, copyTenantId: A.copy.copyTenantId })).toBe("gone");
  }, 60_000);
});
