import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { addJudge, dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { serviceSub } from "../sweep/service-session";
import { autopilotModeFor } from "./mode";
import { readRule } from "./read";
import { parseRuleSave, readRules, saveRule, type RuleSave } from "./rules-admin";
import { autopilotSub } from "./session";
import { setPaused } from "./state";

// The owner's rule saves and the pause's record against the real database, as the app's role: a
// first save makes version 1 with one record and no before; the next makes version 2 with the whole
// before and after; a save on a stale version or a duplicate of one already saved writes nothing
// and answers changed; two saves of one version at once give one write and one record; a save on the
// current version that changes nothing writes nothing, and a stale one answers changed; Auto on a
// never-alone kind is refused in code and by the 0077 check; each carrier sees only its own rules
// and record, and the record only grows; the readers the autopilot decides with see the new rule;
// each Pause and Resume is recorded, two first pauses at once in order; only an admin saves. A
// fixed clock; two tenants made here and removed after.

const savedAutopilot = structuredClone(flags.autopilot);
const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const at = (minutes: number) => new Date(NOW + minutes * 60_000);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let ownerA: Session;
let ownerB: Session;

type ChangeRow = {
  subject: string;
  kind: string | null;
  rule_id: string | null;
  from_version: number | null;
  to_version: number | null;
  before: unknown;
  after: unknown;
  changed_by: string;
  created_at: string;
};

const changesOf = (f: Fixture, subject: "rule" | "pause") =>
  app.withTenant(f.tenantId, (q) =>
    q.query<ChangeRow>(
      `SELECT subject, kind, CAST(rule_id AS text) AS rule_id, from_version, to_version, before, after, changed_by,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
         FROM autopilot_changes WHERE subject = $1 ORDER BY created_at, to_version`,
      [subject],
    ),
  );

const save = (session: Session, body: Record<string, unknown>, when = at(0)) => {
  const parsed = parseRuleSave(body);
  if (!parsed.ok) throw new Error(`the test's body did not parse: ${parsed.category}`);
  return app.withTenant(session.tenantId, (q) => saveRule(q, session, parsed.value, when));
};

const wipe = (f: Fixture) =>
  admin.withTenant(f.tenantId, async (q) => {
    await q.execute("DELETE FROM autopilot_changes WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM autopilot_rules WHERE tenant_id = current_tenant_id()");
    await q.execute("DELETE FROM autopilot_state WHERE tenant_id = current_tenant_id()");
  });

async function addOwner(f: Fixture, slug: string): Promise<Session> {
  const sub = `owner-${f.tenantId}`;
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES
         (current_tenant_id(), $1, $2, 'admin'), (current_tenant_id(), $3, $4, 'staff')`,
      [sub, `owner@${slug}.example`, autopilotSub(f.tenantId), `autopilot@${slug}.invalid`],
    ),
  );
  return { sub, email: "", tenantId: f.tenantId };
}

const INVOICE = { kind: "invoice_post", mode: "auto", maxCents: 100_000, dayMaxCents: 500_000, dayMaxCount: 10, expectedVersion: null };
const values = (r: Partial<RuleSave>) => ({
  mode: r.mode,
  maxCents: r.maxCents,
  dayMaxCents: r.dayMaxCents,
  dayMaxCount: r.dayMaxCount,
  driverDayMaxCents: r.driverDayMaxCents ?? null,
});

describe("the owner's autopilot rules", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const tag = randomUUID().slice(0, 8);
    A = await makeTenant(admin, `rules-a-${tag}`);
    B = await makeTenant(admin, `rules-b-${tag}`);
    ownerA = await addOwner(A, `rules-a-${tag}`);
    ownerB = await addOwner(B, `rules-b-${tag}`);
  });

  beforeEach(async () => {
    Object.assign(flags.autopilot, structuredClone(savedAutopilot), { enabled: true, armed: true });
    await wipe(A);
    await wipe(B);
  });

  afterAll(async () => {
    Object.assign(flags.autopilot, structuredClone(savedAutopilot));
    await dropTenant(admin, A);
    await dropTenant(admin, B);
    await app?.close();
    await admin?.close();
  });

  it("makes version 1 on the first save with one record and no before, then version 2 with the whole before and after", async () => {
    const first = await save(ownerA, INVOICE);
    expect(first).toMatchObject({ ok: true, rule: { kind: "invoice_post", mode: "auto", version: 1, updatedAt: at(0).toISOString() } });
    const ruleId = first.ok ? first.rule.id : "";
    let log = await changesOf(A, "rule");
    expect(log).toEqual([
      {
        subject: "rule",
        kind: "invoice_post",
        rule_id: ruleId,
        from_version: null,
        to_version: 1,
        before: null,
        after: values(INVOICE as Partial<RuleSave>),
        changed_by: ownerA.sub,
        created_at: at(0).toISOString(),
      },
    ]);

    const next = { ...INVOICE, mode: "ask", dayMaxCount: 4, expectedVersion: 1 };
    const second = await save(ownerA, next, at(5));
    expect(second).toMatchObject({ ok: true, rule: { id: ruleId, mode: "ask", dayMaxCount: 4, version: 2 } });
    log = await changesOf(A, "rule");
    expect(log).toHaveLength(2);
    expect(log[1]).toEqual({
      subject: "rule",
      kind: "invoice_post",
      rule_id: ruleId,
      from_version: 1,
      to_version: 2,
      before: values(INVOICE as Partial<RuleSave>),
      after: values(next as Partial<RuleSave>),
      changed_by: ownerA.sub,
      created_at: at(5).toISOString(),
    });
  });

  it("writes nothing on a stale version, a first save of a kind that has a rule, or a later save of one that has none", async () => {
    await save(ownerA, INVOICE);
    await save(ownerA, { ...INVOICE, dayMaxCount: 5, expectedVersion: 1 });
    const stale = await save(ownerA, { ...INVOICE, dayMaxCount: 6, expectedVersion: 1 });
    expect(stale).toMatchObject({ ok: false, category: "changed", rule: { version: 2, dayMaxCount: 5 } });
    const again = await save(ownerA, { ...INVOICE, dayMaxCount: 7, expectedVersion: null });
    expect(again).toMatchObject({ ok: false, category: "changed", rule: { version: 2 } });
    const none = await save(ownerA, { ...INVOICE, kind: "card_match", maxCents: 1_000, dayMaxCents: 2_000, expectedVersion: 3 });
    expect(none).toEqual({ ok: false, category: "changed", rule: null });
    expect(await changesOf(A, "rule")).toHaveLength(2);
    const [rule] = await app.withTenant(A.tenantId, (q) => q.query<{ version: number; day_max_count: number }>(
      "SELECT version, day_max_count FROM autopilot_rules WHERE kind = 'invoice_post'",
    ));
    expect(rule).toEqual({ version: 2, day_max_count: 5 });
  });

  it("gives one write and one record when two saves of one version race", async () => {
    await save(ownerA, INVOICE);
    const out = await Promise.all([
      save(ownerA, { ...INVOICE, dayMaxCount: 8, expectedVersion: 1 }),
      save(ownerA, { ...INVOICE, dayMaxCount: 9, expectedVersion: 1 }),
    ]);
    expect(out.filter((o) => o.ok)).toHaveLength(1);
    expect(out.filter((o) => !o.ok && o.category === "changed")).toHaveLength(1);
    expect(await changesOf(A, "rule")).toHaveLength(2);
    // Two first saves at once: one rule, one record, the other answers changed.
    const firsts = await Promise.all([
      save(ownerA, { ...INVOICE, kind: "card_match", maxCents: 1_000, dayMaxCents: 2_000 }),
      save(ownerA, { ...INVOICE, kind: "card_match", maxCents: 1_500, dayMaxCents: 2_000 }),
    ]);
    expect(firsts.filter((o) => o.ok)).toHaveLength(1);
    expect(firsts.filter((o) => !o.ok && o.category === "changed")).toHaveLength(1);
    expect((await changesOf(A, "rule")).filter((c) => c.kind === "card_match")).toHaveLength(1);
  });

  it("writes nothing when a save on the current version changes nothing, and answers changed when a stale one does", async () => {
    await save(ownerA, INVOICE);
    const same = await save(ownerA, { ...INVOICE, expectedVersion: 1 }, at(9));
    expect(same).toMatchObject({ ok: true, unchanged: true, rule: { version: 1, updatedAt: at(0).toISOString() } });
    expect(await changesOf(A, "rule")).toHaveLength(1);
    // The rule moves to version 2; a save of its values on version 1, or as a first save, is out of date.
    await save(ownerA, { ...INVOICE, dayMaxCount: 5, expectedVersion: 1 });
    const stale = await save(ownerA, { ...INVOICE, dayMaxCount: 5, expectedVersion: 1 }, at(10));
    expect(stale).toMatchObject({ ok: false, category: "changed", rule: { version: 2, dayMaxCount: 5 } });
    const first = await save(ownerA, { ...INVOICE, dayMaxCount: 5, expectedVersion: null }, at(11));
    expect(first).toMatchObject({ ok: false, category: "changed", rule: { version: 2, dayMaxCount: 5 } });
    expect(await changesOf(A, "rule")).toHaveLength(2);
  });

  it("refuses Auto on settlement_approve in code and in the database", async () => {
    expect(parseRuleSave({ ...INVOICE, kind: "settlement_approve" })).toEqual({ ok: false, category: "never_alone" });
    const made = await save(ownerA, { ...INVOICE, kind: "settlement_approve", mode: "ask" });
    expect(made).toMatchObject({ ok: true, rule: { mode: "ask", version: 1 } });
    // Past the code, the 0077 check still refuses it.
    const state = await sqlStateOf(
      app.withTenant(A.tenantId, (q) =>
        q.execute("UPDATE autopilot_rules SET mode = 'auto', version = version + 1 WHERE kind = 'settlement_approve'"),
      ),
    );
    expect(state).toBe("23514");
    const insert = await sqlStateOf(
      app.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, updated_by)
           VALUES (current_tenant_id(), 'pay_correction', 'auto', 1, 1, 1, 'test')`,
        ),
      ),
    );
    expect(insert).toBe("23514");
  });

  it("holds each carrier to its own rules and record, and the record only grows", async () => {
    await save(ownerA, INVOICE);
    await save(ownerB, { ...INVOICE, mode: "off" });
    await setPaused(ownerA, true, { db: app, clock: () => at(0) });
    for (const [f, mode] of [[A, "auto"], [B, "off"]] as const) {
      const seen = await app.withTenant(f.tenantId, async (q) => ({
        rules: await q.query<{ tenant_id: string; mode: string }>(
          "SELECT CAST(tenant_id AS text) AS tenant_id, mode FROM autopilot_rules",
        ),
        changes: await q.query<{ tenant_id: string }>("SELECT CAST(tenant_id AS text) AS tenant_id FROM autopilot_changes"),
      }));
      expect(seen.rules).toEqual([{ tenant_id: f.tenantId, mode }]);
      expect(seen.changes.length).toBeGreaterThanOrEqual(1);
      expect(seen.changes.every((c) => c.tenant_id === f.tenantId)).toBe(true);
    }
    expect(await changesOf(B, "pause")).toEqual([]);
    // B may not write a record into A, and nobody may change or remove a record.
    const cross = await sqlStateOf(
      app.withTenant(B.tenantId, (q) =>
        q.execute(
          `INSERT INTO autopilot_changes (tenant_id, subject, after, changed_by)
           VALUES (CAST($1 AS uuid), 'pause', CAST('{}' AS jsonb), 'x')`,
          [A.tenantId],
        ),
      ),
    );
    expect(cross).toBe("42501");
    expect(await sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute("UPDATE autopilot_changes SET changed_by = 'x'")))).toBe("42501");
    expect(await sqlStateOf(app.withTenant(A.tenantId, (q) => q.execute("DELETE FROM autopilot_changes")))).toBe("42501");
    // A rule's record moves its version by exactly one, and a pause names no rule.
    const [rule] = await app.withTenant(A.tenantId, (q) =>
      q.query<{ id: string }>("SELECT CAST(id AS text) AS id FROM autopilot_rules WHERE kind = 'invoice_post'"),
    );
    const skip = await sqlStateOf(
      app.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO autopilot_changes (tenant_id, subject, kind, rule_id, from_version, to_version, before, after, changed_by)
           VALUES (current_tenant_id(), 'rule', 'invoice_post', CAST($1 AS uuid), 1, 3, CAST('{}' AS jsonb), CAST('{}' AS jsonb), 'x')`,
          [rule.id],
        ),
      ),
    );
    expect(skip).toBe("23514");
    const pauseWithRule = await sqlStateOf(
      app.withTenant(A.tenantId, (q) =>
        q.execute(
          `INSERT INTO autopilot_changes (tenant_id, subject, kind, after, changed_by)
           VALUES (current_tenant_id(), 'pause', 'invoice_post', CAST('{}' AS jsonb), 'x')`,
        ),
      ),
    );
    expect(pauseWithRule).toBe("23514");
  });

  it("is read by the autopilot's own readers at once", async () => {
    const first = await save(ownerA, INVOICE);
    expect(first.ok).toBe(true);
    const read = () =>
      app.withTenant(A.tenantId, async (q) => ({
        mode: await autopilotModeFor(q, "invoice_post", NOW),
        rule: await readRule(q, "invoice_post", false),
      }));
    expect(await read()).toMatchObject({ mode: "auto", rule: { mode: "auto", maxCents: 100_000, version: 1 } });
    await save(ownerA, { ...INVOICE, mode: "off", expectedVersion: 1 });
    expect(await read()).toMatchObject({ mode: "off", rule: { mode: "off", version: 2 } });
    await save(ownerA, { ...INVOICE, mode: "ask", maxCents: 2_000, expectedVersion: 2 });
    expect(await read()).toMatchObject({ mode: "ask", rule: { mode: "ask", maxCents: 2_000, version: 3 } });
    const picture = await app.withTenant(A.tenantId, (q) => readRules(q, NOW));
    expect(picture.rules).toHaveLength(1);
    expect(picture.kinds).toHaveLength(17);
    expect(picture.kinds.find((k) => k.kind === "invoice_post")).toMatchObject({ mode: "ask", allowedAuto: true, listed: true, armed: true });
    expect(picture.kinds.find((k) => k.kind === "settlement_approve")).toMatchObject({ mode: "ask", allowedAuto: false, listed: false, ceiling: null });
    expect(picture.pause).toEqual({ paused: false, pausedAt: null, pausedUntil: null, pausedBy: null });
  });

  it("records each Pause and Resume beside the switch, and says who paused only as a category", async () => {
    expect(await setPaused(ownerA, true, { db: app, clock: () => at(0) })).toEqual({ ok: true, paused: true });
    expect(await setPaused(ownerA, false, { db: app, clock: () => at(3) })).toEqual({ ok: true, paused: false });
    expect(await setPaused(A.session, true, { db: app, clock: () => at(7) })).toEqual({ ok: true, paused: true });
    const paused = { pausedAt: at(0).toISOString(), pausedBy: ownerA.sub, pausedUntil: null };
    const cleared = { pausedAt: null, pausedBy: null, pausedUntil: null };
    expect(await changesOf(A, "pause")).toEqual([
      { subject: "pause", kind: null, rule_id: null, from_version: null, to_version: null, before: null, after: paused, changed_by: ownerA.sub, created_at: at(0).toISOString() },
      { subject: "pause", kind: null, rule_id: null, from_version: null, to_version: null, before: paused, after: cleared, changed_by: ownerA.sub, created_at: at(3).toISOString() },
      {
        subject: "pause",
        kind: null,
        rule_id: null,
        from_version: null,
        to_version: null,
        before: cleared,
        after: { pausedAt: at(7).toISOString(), pausedBy: A.session.sub, pausedUntil: null },
        changed_by: A.session.sub,
        created_at: at(7).toISOString(),
      },
    ]);
    const picture = await app.withTenant(A.tenantId, (q) => readRules(q, NOW + 8 * 60_000));
    expect(picture.pause).toEqual({ paused: true, pausedAt: at(7).toISOString(), pausedUntil: null, pausedBy: "person" });
    // A refused resume records nothing.
    expect(await setPaused(A.session, false, { db: app, clock: () => at(9) })).toEqual({ ok: false, category: "role" });
    expect(await changesOf(A, "pause")).toHaveLength(3);
  });

  it("orders two first pauses at once: two records, and the second's before is the first's after", async () => {
    const out = await Promise.all([
      setPaused(ownerA, true, { db: app, clock: () => at(0) }),
      setPaused(A.session, true, { db: app, clock: () => at(1) }),
    ]);
    expect(out).toEqual([{ ok: true, paused: true }, { ok: true, paused: true }]);
    const log = await changesOf(A, "pause");
    expect(log).toHaveLength(2);
    const firsts = log.filter((c) => c.before === null);
    expect(firsts).toHaveLength(1);
    const second = log.find((c) => c.before !== null);
    expect(second?.before).toEqual(firsts[0].after);
  });

  it("lets only an admin save: staff, a demo visitor and the service logins write nothing", async () => {
    const judge = await addJudge(admin, A);
    const pilot: Session = { sub: autopilotSub(A.tenantId), email: "", tenantId: A.tenantId };
    const sweep: Session = { sub: serviceSub(A.tenantId), email: "", tenantId: A.tenantId };
    expect(await save(A.session, INVOICE)).toEqual({ ok: false, category: "role" });
    expect(await save(judge, INVOICE)).toEqual({ ok: false, category: "role" });
    expect(await save(pilot, INVOICE)).toEqual({ ok: false, category: "forbidden" });
    expect(await save(sweep, INVOICE)).toEqual({ ok: false, category: "forbidden" });
    const counts = await app.withTenant(A.tenantId, async (q) => ({
      rules: await q.query("SELECT 1 FROM autopilot_rules"),
      changes: await q.query("SELECT 1 FROM autopilot_changes"),
    }));
    expect(counts).toEqual({ rules: [], changes: [] });
  });
});
