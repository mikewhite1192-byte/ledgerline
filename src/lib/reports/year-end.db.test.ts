import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { callTool } from "../agent/gateway";
import type { AgentRole, GatewayContext } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import { readPaidBetween } from "../data/read";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { CORRECTION_SUBKIND, correctionItemRef } from "../proposals/executors/pay-correction";
import { cents, itemLines, type PayItemRecord } from "../rules-engine";
import { instantAt } from "../seed/calendar";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan, type CarrierPlan } from "../seed/plan";
import { replaceTenantData } from "../seed/run";
import { localDateOf } from "../time/local-date";
import { parseReportArgs } from "./args";
import { reportForSession } from "./for-session";
import { ReportsOffError } from "./switch";
import { isRefCell, type ReportResult, type ReportRow } from "./types";
import { yearEndWindow } from "./year-end";

// The year-end 1099 against a real database, as the app's own role, on both seeded demo carriers:
// each carrier's totals equal its own plan's paid contractor settlements, through the tool and the
// download alike; a settlement paid at 23:30 on Dec 31 in the carrier's own zone counts in the old
// year and one at 00:30 on Jan 1 in the new; an approved or draft settlement never counts; the
// other carrier's driver is refused or reads as nothing; an approved pay correction of either sign
// is shown apart and never counted, a line labeled as a correction is not one, and a named driver
// is read alone; dark, the tool is unknown and the report is refused. Throwaway pay weeks,
// settlements and pay items are removed after each test, failure paths included, and the two demo tenants after the file (the fresh test database has no others with
// those slugs).

const [BR, PW] = DEMO_CARRIERS;
const ANCHOR = golden.anchor;
const NOW = Date.UTC(2026, 10, 2, 17, 0, 0);
const YEAR = "2026";

type Seeded = { id: string; carrier: DemoCarrier; plan: CarrierPlan };
const tenants: Seeded[] = [BR, PW].map((carrier) => ({
  id: randomUUID(),
  carrier,
  plan: buildCarrierPlan(carrier, ANCHOR),
}));
const [A, B] = tenants;

let admin: Db;
let app: Db;

const session = (t: Seeded): Session => ({ sub: `sub-${t.id}`, email: `ops@${t.carrier.slug}.example`, tenantId: t.id });

const ctx = (t: Seeded, role: AgentRole = "operator"): GatewayContext => ({
  session: session(t),
  role,
  model: "spark",
  turnId: null,
  traceId: `trace-year-end-${t.id.slice(0, 8)}`,
  now: new Date(NOW),
  deadlineAt: NOW + 60_000,
  timeZone: t.carrier.timezone,
});
const clock = () => NOW;
const call = (args: unknown) => ({ id: "c", name: "report_year_end_contractors", argumentsJson: JSON.stringify(args) });

async function viaTool(t: Seeded, args: Record<string, string>, role: AgentRole = "operator"): Promise<ReportResult> {
  const out = await callTool(ctx(t, role), call(args), { db: app, clock });
  expect(out.decision, `${t.carrier.slug} ${role}`).toBe("allowed");
  return out.result as unknown as ReportResult;
}

async function viaDownload(t: Seeded, args: Record<string, string>): Promise<ReportResult> {
  const request = parseReportArgs("year_end_contractors", args);
  if (!request) throw new Error("bad args");
  return reportForSession(session(t), request, new Date(NOW), app);
}

// The plan's own sums for a year, worked from its rows apart from the report.
function planSums(plan: CarrierPlan, year: string) {
  const zone = plan.carrier.timezone;
  const contractors = new Set(plan.rows.drivers.filter((d) => d.worker_type === "owner_operator").map((d) => d.id));
  const kept = plan.rows.settlements.filter(
    (s) =>
      s.status === "paid" &&
      s.paid_at !== null &&
      localDateOf(s.paid_at, zone).startsWith(year) &&
      contractors.has(s.driver_id),
  );
  const ids = new Set(kept.map((s) => s.id));
  // A line made from an approved pay correction's item is a correction, whatever its kind.
  const corrections = new Set(plan.rows.pay_items.filter((i) => i.ref_table === "proposals").map((i) => i.id));
  const isCorrection = (l: (typeof plan.rows.settlement_lines)[number]) =>
    l.sources.some((src) => src.table === "pay_items" && corrections.has(src.id));
  const lines = plan.rows.settlement_lines.filter((l) => ids.has(l.settlement_id));
  const total = (kinds: string[]) =>
    lines.filter((l) => kinds.includes(l.kind) && !isCorrection(l)).reduce((n, l) => n + l.amount_cents, 0);
  return {
    totals: {
      settlementsPaid: kept.length,
      compensationCents: total(["load_pay", "accessorial_pay"]),
      reimbursementsCents: total(["reimbursement"]),
      correctionsCents: lines.filter(isCorrection).reduce((n, l) => n + l.amount_cents, 0),
    },
    contractors: new Set(kept.map((s) => s.driver_id)).size,
  };
}

const idOf = (row: ReportRow) => (isRefCell(row.driver) ? row.driver.id : "");
const rowFor = (r: ReportResult, driverId: string) => r.rows.find((row) => idOf(row) === driverId);

type Throwaway = { periods: string[]; settlements: string[]; payItems: string[] };
const throwaway = (): Throwaway => ({ periods: [], settlements: [], payItems: [] });

// A throwaway pay week (start to start + 6) on a tenant.
async function insertPeriod(t: Seeded, start: string, made: Throwaway): Promise<string> {
  const id = randomUUID();
  await admin.withTenant(t.id, (q) =>
    q.execute(
      `INSERT INTO settlement_periods (id, tenant_id, period_start, period_end, status)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($2 AS date) + 6, 'paid')`,
      [id, start],
    ),
  );
  made.periods.push(id);
  return id;
}

// A throwaway settlement with its earning lines, gross equal to their sum and net equal to gross.
async function insertSettlement(
  t: Seeded,
  made: Throwaway,
  s: { periodId: string; driverId: string; status: "draft" | "approved" | "paid"; paidAt: string | null },
  lines: [kind: string, cents: number][],
): Promise<string> {
  const id = randomUUID();
  const gross = lines.reduce((n, [, cents]) => n + cents, 0);
  await admin.withTenant(t.id, async (q) => {
    await q.execute(
      `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents, deductions_cents,
         net_cents, paid_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), CAST($4 AS uuid), $5, $6, 0, $6,
         CAST($7 AS timestamptz))`,
      [id, s.periodId, s.driverId, t.plan.rows.pay_configs[0].id, s.status, gross, s.paidAt],
    );
    made.settlements.push(id);
    let seq = 0;
    for (const [kind, cents] of lines) {
      seq += 1;
      await q.execute(
        `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, 'Year-end test line', $5, '[]'::jsonb)`,
        [randomUUID(), id, seq, kind, cents],
      );
    }
  });
  return id;
}

// One paystub line on a throwaway settlement, with the label and sources given.
async function insertLine(
  t: Seeded,
  settlementId: string,
  seq: number,
  line: { kind: string; label: string; amountCents: number; sources: readonly { table: string; id: string }[] },
): Promise<void> {
  await admin.withTenant(t.id, (q) =>
    q.execute(
      `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6, CAST($7 AS jsonb))`,
      [randomUUID(), settlementId, seq, line.kind, line.label, line.amountCents, JSON.stringify(line.sources)],
    ),
  );
}

// A pay correction settled on a throwaway paid settlement, with the paystub line the engine makes
// from it: approved, the item as the executor writes it (ref_table 'proposals'); not approved, an
// item that says correction only in its subkind, and so in its line's label.
async function insertCorrection(
  t: Seeded,
  made: Throwaway,
  at: { settlementId: string; driverId: string; weekStart: string; seq: number },
  deltaCents: number,
  approved = true,
): Promise<string> {
  const id = randomUUID();
  const proposalId = randomUUID();
  const item: PayItemRecord = {
    id,
    driverId: at.driverId,
    kind: deltaCents > 0 ? "reimbursement" : "other_deduction",
    subkind: CORRECTION_SUBKIND,
    amountCents: cents(Math.abs(deltaCents)),
    itemDate: at.weekStart,
    refTable: approved ? "proposals" : null,
    refId: approved ? proposalId : null,
    itemRef: approved ? correctionItemRef(proposalId) : `year-end-test:${id}`,
    description: "Year-end test correction",
    settlementId: at.settlementId,
  };
  const [line] = itemLines([item], item.kind, { start: at.weekStart, end: at.weekStart });
  if (line === undefined || line.amountCents !== deltaCents) throw new Error("the engine made no line from the correction");
  await admin.withTenant(t.id, (q) =>
    q.execute(
      `INSERT INTO pay_items (id, tenant_id, driver_id, kind, subkind, amount_cents, item_date, ref_table, ref_id,
         item_ref, description, settlement_id)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, CAST($6 AS date), $7,
         CAST($8 AS uuid), $9, $10, CAST($11 AS uuid))`,
      [
        id,
        item.driverId,
        item.kind,
        item.subkind,
        item.amountCents,
        item.itemDate,
        item.refTable,
        item.refId,
        item.itemRef,
        item.description,
        item.settlementId,
      ],
    ),
  );
  made.payItems.push(id);
  await insertLine(t, at.settlementId, at.seq, line);
  return id;
}

async function removeThrowaway(t: Seeded, made: Throwaway): Promise<void> {
  await admin.withTenant(t.id, async (q) => {
    // The pay items name their settlements, so they go first.
    for (const id of made.payItems) {
      await q.execute("DELETE FROM pay_items WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]);
    }
    for (const id of made.settlements) {
      await q.execute(
        "DELETE FROM settlement_lines WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid)",
        [id],
      );
      await q.execute("DELETE FROM settlements WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]);
    }
    for (const id of made.periods) {
      await q.execute("DELETE FROM settlement_periods WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]);
    }
  });
}

describe("the year-end 1099 on a seeded database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug IN ($1, $2) ORDER BY slug", [BR.slug, PW.slug]),
    );
    if (leftover.length > 0) {
      throw new Error(
        `a tenant ${leftover[0].slug} already exists: the database tests need a fresh database ` +
          "(npm run test:db:fresh)",
      );
    }
    for (const t of tenants) {
      await admin.withTenant(t.id, (q) =>
        q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
          t.carrier.slug,
          t.carrier.name,
          t.carrier.timezone,
        ]),
      );
      await replaceTenantData(app, t.id, t.plan);
      await admin.withTenant(t.id, (q) =>
        q.execute(
          "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')",
          [`sub-${t.id}`, `ops@${t.carrier.slug}.example`],
        ),
      );
    }
    flags.reportsEnabled = true;
    flags.yearEndEnabled = true;
  });

  afterAll(async () => {
    flags.reportsEnabled = false;
    flags.yearEndEnabled = false;
    // Only what this file made: the two tenants (their rows and memberships go with them, by cascade).
    for (const t of tenants) {
      await admin?.withTenant(t.id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("sums each carrier's own contractors from its own paid settlements, the tool and the download alike", async () => {
    for (const [own, other] of [
      [A, B],
      [B, A],
    ] as const) {
      const want = planSums(own.plan, YEAR);
      expect(want.contractors, own.carrier.slug).toBeGreaterThan(0);
      const tool = await viaTool(own, { year: YEAR });
      expect(tool.totals, own.carrier.slug).toEqual(want.totals);
      expect(tool.rowsTotal, own.carrier.slug).toBe(want.contractors);
      expect(tool.form1099, own.carrier.slug).toMatchObject({ taxYear: 2026, thresholdCents: 200_000, unclassified: 0 });
      const mine = new Set(own.plan.rows.drivers.map((d) => d.id));
      for (const row of tool.rows) expect(mine.has(idOf(row)), own.carrier.slug).toBe(true);
      const text = JSON.stringify(tool);
      for (const d of other.plan.rows.drivers) expect(text.includes(d.id), `${own.carrier.slug} shows ${d.id}`).toBe(false);
      for (const d of own.plan.rows.drivers) expect(text.includes(d.email), `${own.carrier.slug} shows an email`).toBe(false);

      const download = await viaDownload(own, { year: YEAR });
      expect(download.totals).toEqual(tool.totals);
      expect(download.rowsTotal).toBe(tool.rowsTotal);
      expect(download.form1099).toEqual(tool.form1099);
      // The auditor reads the same figures.
      expect((await viaTool(own, { year: YEAR }, "auditor")).totals).toEqual(tool.totals);
    }
  });

  it("counts by the carrier's own paid date across New Year, and never an approved or draft settlement", async () => {
    for (const t of tenants) {
      const zone = t.carrier.timezone;
      const contractors = t.plan.rows.drivers.filter((d) => d.worker_type === "owner_operator");
      expect(contractors.length, t.carrier.slug).toBeGreaterThanOrEqual(3);
      const [x, y, z] = contractors;
      const starts = new Set(t.plan.rows.settlement_periods.map((p) => p.period_start));
      expect(starts.has("2025-12-29") || starts.has("2025-12-22"), t.carrier.slug).toBe(false);
      const before = await viaTool(t, { year: YEAR });
      expect((await viaTool(t, { year: "2025" })).rows, t.carrier.slug).toEqual([]);
      const late = instantAt("2025-12-31", 23, 30, zone);
      const early = instantAt("2026-01-01", 0, 30, zone);
      expect(localDateOf(late, zone)).toBe("2025-12-31");
      expect(localDateOf(early, zone)).toBe("2026-01-01");
      // Both are already Jan 1 in UTC, so only the carrier's own date can tell them apart.
      expect(new Date(late).toISOString().slice(0, 10)).toBe("2026-01-01");
      const made = throwaway();
      try {
        const week = await insertPeriod(t, "2025-12-29", made);
        const earlier = await insertPeriod(t, "2025-12-22", made);
        await insertSettlement(t, made, { periodId: week, driverId: x.id, status: "paid", paidAt: late }, [["load_pay", 12_345]]);
        await insertSettlement(t, made, { periodId: week, driverId: y.id, status: "paid", paidAt: early }, [
          ["load_pay", 23_456],
          ["reimbursement", 1_111],
        ]);
        // Approved with a paid time in the year, and a draft: neither is paid, so neither counts.
        const inYear = instantAt("2026-03-02", 12, 0, zone);
        await insertSettlement(t, made, { periodId: week, driverId: z.id, status: "approved", paidAt: inYear }, [
          ["load_pay", 99_999],
        ]);
        await insertSettlement(t, made, { periodId: earlier, driverId: x.id, status: "draft", paidAt: null }, [
          ["load_pay", 88_888],
        ]);

        const after = await viaTool(t, { year: YEAR });
        expect(after.totals, t.carrier.slug).toEqual({
          settlementsPaid: (before.totals?.settlementsPaid ?? 0) + 1,
          compensationCents: (before.totals?.compensationCents ?? 0) + 23_456,
          reimbursementsCents: (before.totals?.reimbursementsCents ?? 0) + 1_111,
          correctionsCents: before.totals?.correctionsCents ?? 0,
        });
        const yBefore = rowFor(before, y.id);
        expect(rowFor(after, y.id), t.carrier.slug).toMatchObject({
          settlementsPaid: Number(yBefore?.settlementsPaid ?? 0) + 1,
          compensationCents: Number(yBefore?.compensationCents ?? 0) + 23_456,
          firstPaidOn: "2026-01-01",
        });
        expect(rowFor(after, x.id), t.carrier.slug).toEqual(rowFor(before, x.id));
        expect(rowFor(after, z.id), t.carrier.slug).toEqual(rowFor(before, z.id));

        const old = await viaTool(t, { year: "2025" });
        expect(old.rows.map(idOf), t.carrier.slug).toEqual([x.id]);
        expect(old.rows[0]).toMatchObject({
          settlementsPaid: 1,
          compensationCents: 12_345,
          reimbursementsCents: 0,
          meetsThreshold: "no",
          firstPaidOn: "2025-12-31",
          lastPaidOn: "2025-12-31",
        });
        expect(old.form1099).toEqual({ taxYear: 2025, thresholdCents: 60_000, meeting: 0, unclassified: 0 });
        expect((await viaDownload(t, { year: "2025" })).totals).toEqual(old.totals);
      } finally {
        await removeThrowaway(t, made);
      }
      expect((await viaTool(t, { year: YEAR })).totals, t.carrier.slug).toEqual(before.totals);
    }
  });

  it("shows an approved pay correction of either sign apart, never by its label, and only on its own carrier", async () => {
    const WEEK = "2026-01-05";
    const runs = tenants.map((t) => ({ t, made: throwaway() }));
    const placed: {
      t: Seeded;
      driverId: string;
      before: ReportResult;
      settlementId: string;
      approved: string[];
      decoy: string;
    }[] = [];
    try {
      for (const { t, made } of runs) {
        const x = t.plan.rows.drivers.find((d) => d.worker_type === "owner_operator");
        if (!x) throw new Error("no contractor in the plan");
        expect(t.plan.rows.settlement_periods.some((p) => p.period_start === WEEK), t.carrier.slug).toBe(false);
        const before = await viaTool(t, { year: YEAR });
        const periodId = await insertPeriod(t, WEEK, made);
        const paidAt = instantAt("2026-01-09", 12, 0, t.carrier.timezone);
        const settlementId = await insertSettlement(t, made, { periodId, driverId: x.id, status: "paid", paidAt }, [
          ["load_pay", 50_000],
          ["reimbursement", 1_000],
        ]);
        const at = (seq: number) => ({ settlementId, driverId: x.id, weekStart: WEEK, seq });
        const approved = [await insertCorrection(t, made, at(3), 2_500), await insertCorrection(t, made, at(4), -800)];
        // Corrections only by their labels: an item no one approved, and two lines with no source.
        const decoy = await insertCorrection(t, made, at(5), -600, false);
        await insertLine(t, settlementId, 6, {
          kind: "reimbursement",
          label: "Reimbursement (correction)",
          amountCents: 300,
          sources: [],
        });
        await insertLine(t, settlementId, 7, {
          kind: "other_deduction",
          label: "Deduction (correction)",
          amountCents: -400,
          sources: [],
        });
        placed.push({ t, driverId: x.id, before, settlementId, approved, decoy });
      }
      for (const { t, driverId, before, settlementId, approved, decoy } of placed) {
        const after = await viaTool(t, { year: YEAR });
        // The earnings count, both reimbursements count as reimbursements, and only the two approved
        // corrections are corrections: 2,500 - 800.
        expect(after.totals, t.carrier.slug).toEqual({
          settlementsPaid: (before.totals?.settlementsPaid ?? 0) + 1,
          compensationCents: (before.totals?.compensationCents ?? 0) + 50_000,
          reimbursementsCents: (before.totals?.reimbursementsCents ?? 0) + 1_300,
          correctionsCents: (before.totals?.correctionsCents ?? 0) + 1_700,
        });
        const was = rowFor(before, driverId);
        expect(rowFor(after, driverId), t.carrier.slug).toMatchObject({
          settlementsPaid: Number(was?.settlementsPaid ?? 0) + 1,
          compensationCents: Number(was?.compensationCents ?? 0) + 50_000,
          reimbursementsCents: Number(was?.reimbursementsCents ?? 0) + 1_300,
          correctionsCents: Number(was?.correctionsCents ?? 0) + 1_700,
        });
        expect(after.notes?.some((n) => n.startsWith("Pay corrections are shown apart")), t.carrier.slug).toBe(true);
        expect((await viaDownload(t, { year: YEAR })).totals, t.carrier.slug).toEqual(after.totals);

        const read = await app.withTenant(t.id, (q) => readPaidBetween(q, yearEndWindow(2026)));
        const items = read.pay_items.map((i) => i.id);
        for (const id of approved) expect(items, t.carrier.slug).toContain(id);
        expect(items, t.carrier.slug).not.toContain(decoy);
        expect(read.pay_items.every((i) => i.ref_table === "proposals"), t.carrier.slug).toBe(true);
        // Of the throwaway settlement's lines: the earnings, both reimbursements and the approved
        // corrections; never a deduction that is a correction only by its label.
        const seqs = read.settlement_lines
          .filter((l) => l.settlement_id === settlementId)
          .map((l) => l.seq)
          .sort((p, q) => p - q);
        expect(seqs, t.carrier.slug).toEqual([1, 2, 3, 4, 6]);
        // Nothing the other carrier made is read here.
        for (const other of placed.filter((p) => p.t !== t)) {
          for (const id of [...other.approved, other.decoy]) expect(items, t.carrier.slug).not.toContain(id);
          expect(read.settlements.some((st) => st.id === other.settlementId), t.carrier.slug).toBe(false);
          expect(read.settlement_lines.some((l) => l.settlement_id === other.settlementId), t.carrier.slug).toBe(false);
        }
      }
    } finally {
      for (const { t, made } of runs) await removeThrowaway(t, made);
    }
    for (const { t, before } of placed) expect((await viaTool(t, { year: YEAR })).totals, t.carrier.slug).toEqual(before.totals);
  });

  it("reads only the named contractor's rows, and the other carrier's driver as nothing", async () => {
    const WEEK = "2026-01-12";
    const window = yearEndWindow(2026);
    for (const [t, other] of [
      [A, B],
      [B, A],
    ] as const) {
      const [x, y] = t.plan.rows.drivers.filter((d) => d.worker_type === "owner_operator");
      const theirs = other.plan.rows.drivers.find((d) => d.worker_type === "owner_operator");
      if (!x || !y || !theirs) throw new Error("too few contractors in the plans");
      expect(t.plan.rows.settlement_periods.some((p) => p.period_start === WEEK), t.carrier.slug).toBe(false);
      const xBefore = await viaTool(t, { year: YEAR, driverId: x.id });
      const made = throwaway();
      try {
        const periodId = await insertPeriod(t, WEEK, made);
        const paidAt = instantAt("2026-01-16", 12, 0, t.carrier.timezone);
        const sx = await insertSettlement(t, made, { periodId, driverId: x.id, status: "paid", paidAt }, [["load_pay", 40_000]]);
        const sy = await insertSettlement(t, made, { periodId, driverId: y.id, status: "paid", paidAt }, [["load_pay", 30_000]]);
        const cx = await insertCorrection(t, made, { settlementId: sx, driverId: x.id, weekStart: WEEK, seq: 2 }, 900);
        const cy = await insertCorrection(t, made, { settlementId: sy, driverId: y.id, weekStart: WEEK, seq: 2 }, -700);

        const all = await app.withTenant(t.id, (q) => readPaidBetween(q, window));
        const one = await app.withTenant(t.id, (q) => readPaidBetween(q, { ...window, driverId: x.id }));
        expect(all.settlements.map((st) => st.id), t.carrier.slug).toEqual(expect.arrayContaining([sx, sy]));
        expect(all.pay_items.map((i) => i.id), t.carrier.slug).toEqual(expect.arrayContaining([cx, cy]));
        // The named read is exactly the whole read's rows for that driver, so nothing of another
        // driver's ever reaches a page.
        const xs = new Set(all.settlements.filter((st) => st.driver_id === x.id).map((st) => st.id));
        expect(one.settlements, t.carrier.slug).toEqual(all.settlements.filter((st) => st.driver_id === x.id));
        expect(one.settlement_lines, t.carrier.slug).toEqual(all.settlement_lines.filter((l) => xs.has(l.settlement_id)));
        expect(one.drivers.map((d) => d.id), t.carrier.slug).toEqual([x.id]);
        expect(one.pay_items, t.carrier.slug).toEqual(all.pay_items.filter((i) => i.driver_id === x.id));
        expect(one.settlements.map((st) => st.id), t.carrier.slug).toContain(sx);
        expect(one.settlements.some((st) => st.id === sy || st.driver_id !== x.id), t.carrier.slug).toBe(false);
        expect(one.settlement_lines.some((l) => l.settlement_id === sy), t.carrier.slug).toBe(false);
        expect(one.settlement_lines.some((l) => l.sources[0]?.id === cx), t.carrier.slug).toBe(true);
        expect(one.pay_items.map((i) => i.id), t.carrier.slug).toContain(cx);
        expect(one.pay_items.map((i) => i.id), t.carrier.slug).not.toContain(cy);

        // The other carrier's contractor named here reads as nothing at all.
        const none = await app.withTenant(t.id, (q) => readPaidBetween(q, { ...window, driverId: theirs.id }));
        expect(none, t.carrier.slug).toEqual({ settlements: [], settlement_lines: [], drivers: [], pay_items: [] });

        // The tool's one row carries the named driver's correction.
        const tool = await viaTool(t, { year: YEAR, driverId: x.id });
        expect(tool.rows.map(idOf), t.carrier.slug).toEqual([x.id]);
        expect(tool.rows[0], t.carrier.slug).toMatchObject({
          compensationCents: Number(xBefore.rows[0]?.compensationCents ?? 0) + 40_000,
          correctionsCents: Number(xBefore.rows[0]?.correctionsCents ?? 0) + 900,
        });
      } finally {
        await removeThrowaway(t, made);
      }
    }
  });

  it("refuses the other carrier's driver through the tool and reads it as nothing through the download", async () => {
    const theirs = B.plan.rows.drivers.find((d) => d.worker_type === "owner_operator");
    if (!theirs) throw new Error("no contractor in the plan");
    const out = await callTool(ctx(A), call({ year: YEAR, driverId: theirs.id }), { db: app, clock });
    expect(out).toMatchObject({ decision: "blocked", reason: "unknown_record" });
    const download = await viaDownload(A, { year: YEAR, driverId: theirs.id });
    expect(download.rows).toEqual([]);
    expect(download.emptyReason).toBe("no_rows");
    // The same id on its own carrier narrows to one row.
    const own = await viaDownload(B, { year: YEAR, driverId: theirs.id });
    expect(own.rows.map(idOf)).toEqual([theirs.id]);
  });

  it("is not offered and is refused while its own switch is off, with the reports on", async () => {
    flags.yearEndEnabled = false;
    try {
      expect(flags.reportsEnabled).toBe(true);
      for (const role of ["operator", "auditor"] as const) {
        const out = await callTool(ctx(A, role), call({ year: YEAR }), { db: app, clock });
        expect(out.decision, role).toBe("unknown_tool");
      }
      await expect(viaDownload(A, { year: YEAR })).rejects.toBeInstanceOf(ReportsOffError);
    } finally {
      flags.yearEndEnabled = true;
    }
  });
});
