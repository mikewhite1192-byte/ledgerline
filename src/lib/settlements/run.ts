import { randomUUID } from "node:crypto";
import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import { readCheckInput, readPayConfigFor, readSettlementInput } from "../data/read";
import { persistEngineProposal, retireEngineProposalsExcept } from "../proposals/engine";
import { runAllChecks, settleDriver, type Finding, type Period } from "../rules-engine";
import { assertMembership } from "../tenant/context";
import { linesHash } from "./hash";
import { readPeriod, tenantLock } from "./stored";

// "Run the week": the rules engine drafts each driver's paystub for one open pay period and makes
// the card a person approves. Never on a schedule; a person presses it. Each driver is one short
// transaction: the draft row and its lines are rewritten whole (a parked draft is recomputed and
// its park cleared, the only thing that clears one), and the card is persisted with the totals and
// the lines' fingerprint, so a run that changes nothing makes no new card and any pay change makes
// one (the old waiting card is retired). An approved or paid settlement is never touched. A driver
// with nothing to pay and no lines has no draft; a stale draft of theirs is removed. Nothing here
// writes outside the app, and nothing moves money.

export type RunCounts = {
  drafts: number;
  // Drafts carrying at least one exception or finding.
  exceptions: number;
  // Drafts with no exception and money to send (still waiting on the auditor to be clean).
  clean: number;
  skipped: number;
  // Approved or paid already: left alone.
  locked: number;
  truncated: boolean;
};

export type RunResult =
  | { ok: true; periodId: string; counts: RunCounts }
  | { ok: false; category: "disabled" | "not_found" | "not_open" | "before_start" };

type Candidate = { id: string; code: string };

// Every driver with something in the period: a delivered load, a day worked, a pay item dated in
// it, an advance still owed, or a draft already there.
async function candidates(q: Queryable, period: Period & { id: string }): Promise<Candidate[]> {
  return q.query<Candidate>(
    `SELECT d.id, d.code FROM drivers d
      WHERE d.tenant_id = current_tenant_id() AND (
        EXISTS (SELECT 1 FROM loads l
                 WHERE l.tenant_id = d.tenant_id AND l.driver_id = d.id
                   AND l.status IN ('delivered', 'invoiced')
                   AND l.delivered_on BETWEEN CAST($1 AS date) AND CAST($2 AS date))
        OR EXISTS (SELECT 1 FROM driver_days x
                    WHERE x.tenant_id = d.tenant_id AND x.driver_id = d.id
                      AND x.day BETWEEN CAST($1 AS date) AND CAST($2 AS date))
        OR EXISTS (SELECT 1 FROM pay_items i
                    WHERE i.tenant_id = d.tenant_id AND i.driver_id = d.id
                      AND i.item_date BETWEEN CAST($1 AS date) AND CAST($2 AS date))
        OR EXISTS (SELECT 1 FROM advances a
                    WHERE a.tenant_id = d.tenant_id AND a.driver_id = d.id
                      AND a.status IN ('approved', 'paid')
                      AND a.recovered_cents < a.amount_cents + a.fee_cents)
        OR EXISTS (SELECT 1 FROM settlements s
                    WHERE s.tenant_id = d.tenant_id AND s.driver_id = d.id
                      AND s.period_id = CAST($3 AS uuid)))
      ORDER BY d.code, d.id`,
    [period.start, period.end, period.id],
  );
}

type DriverOutcome =
  | { kind: "draft"; settlementId: string; exception: boolean; clean: boolean }
  | { kind: "skipped"; removedId: string | null }
  | { kind: "locked" };

async function draftDriver(
  q: Queryable,
  session: Session,
  period: Period & { id: string },
  driverId: string,
  findings: readonly Finding[],
  now: Date,
): Promise<DriverOutcome> {
  await tenantLock(q, "settlement_run");
  const [existing] = await q.query<{ id: string; status: string }>(
    `SELECT id, status FROM settlements
      WHERE tenant_id = current_tenant_id() AND period_id = CAST($1 AS uuid)
        AND driver_id = CAST($2 AS uuid)
      FOR UPDATE`,
    [period.id, driverId],
  );
  if (existing && existing.status !== "draft") return { kind: "locked" };
  const input = await readSettlementInput(q, driverId, period.id);
  const result = settleDriver(input);

  if (result.lines.length === 0 && result.netCents === 0) {
    if (!existing) return { kind: "skipped", removedId: null };
    await q.execute(
      `DELETE FROM settlement_lines WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid)`,
      [existing.id],
    );
    await q.execute(
      `DELETE FROM settlements WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'draft'`,
      [existing.id],
    );
    return { kind: "skipped", removedId: existing.id };
  }

  const config = await readPayConfigFor(q, period.start);
  const mine = findings.filter((f) => f.driverId === driverId);
  const categories = [...new Set([...result.exceptions.map((e) => e.category), ...mine.map((f) => f.category)])];
  const exceptionCount = result.exceptions.length + mine.length;
  const settlementId = existing?.id ?? randomUUID();
  const totals = [result.grossCents, result.deductionsCents, result.netCents, result.carryForwardCents];

  if (existing) {
    const moved = await q.execute(
      `UPDATE settlements
          SET pay_config_id = CAST($2 AS uuid), gross_cents = $3, deductions_cents = $4, net_cents = $5,
              carry_forward_cents = $6, exception_count = $7, parked_reason = NULL, parked_at = NULL
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'draft'`,
      [settlementId, config.id, ...totals, exceptionCount],
    );
    if (moved !== 1) throw new Error("draft rewrite lost its lock");
    await q.execute(
      `DELETE FROM settlement_lines WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid)`,
      [settlementId],
    );
  } else {
    await q.execute(
      `INSERT INTO settlements (id, tenant_id, period_id, driver_id, pay_config_id, status, gross_cents,
                                deductions_cents, net_cents, carry_forward_cents, exception_count)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid),
               CAST($4 AS uuid), 'draft', $5, $6, $7, $8, $9)`,
      [settlementId, period.id, driverId, config.id, ...totals, exceptionCount],
    );
  }
  // A line a person typed carries their name and its record (0084), copied from its pay item.
  for (const line of result.lines) {
    await q.execute(
      `INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, label, amount_cents, sources, meta,
                                     entered_by, source_ref)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6,
               CAST($7 AS jsonb), CAST($8 AS jsonb), CAST($9 AS uuid), $10)`,
      [
        randomUUID(),
        settlementId,
        line.seq,
        line.kind,
        line.label,
        line.amountCents,
        JSON.stringify(line.sources),
        line.meta ? JSON.stringify(line.meta) : null,
        line.enteredBy ?? null,
        line.sourceRef ?? null,
      ],
    );
  }

  await persistEngineProposal(
    q,
    {
      kind: "settlement_approve",
      subjectTable: "settlements",
      subjectId: settlementId,
      amountCents: result.netCents,
      args: {
        settlementId,
        driverId,
        periodId: period.id,
        grossCents: result.grossCents,
        deductionsCents: result.deductionsCents,
        netCents: result.netCents,
        carryForwardCents: result.carryForwardCents,
        linesHash: linesHash(result.lines),
      },
      exceptions: categories,
      reasons: ["engine_pay"],
      sources: result.lines.flatMap((l) => l.sources),
    },
    session,
    now,
  );
  return {
    kind: "draft",
    settlementId,
    exception: categories.length > 0,
    clean: categories.length === 0 && result.netCents > 0,
  };
}

export async function runPayPeriod(
  db: TenantDb,
  session: Session,
  periodId: string,
  now: Date,
): Promise<RunResult> {
  if (!flags.settlementsEnabled) return { ok: false, category: "disabled" };
  const tenantId = session.tenantId;
  const start = await db.withTenant(tenantId, async (q) => {
    await assertMembership(q, session);
    const period = await readPeriod(q, periodId);
    if (!period) return { ok: false as const, category: "not_found" as const };
    if (period.status !== "open") return { ok: false as const, category: "not_open" as const };
    if (period.start < flags.settlementsStart) return { ok: false as const, category: "before_start" as const };
    const drivers = await candidates(q, period);
    // Findings once per run, over the tenant's records; each draft takes its driver's.
    const findings = runAllChecks(await readCheckInput(q));
    return { ok: true as const, period, drivers, findings };
  });
  if (!start.ok) return start;

  const counts: RunCounts = { drafts: 0, exceptions: 0, clean: 0, skipped: 0, locked: 0, truncated: false };
  const cap = flags.settlementLimits.driversPerRun;
  const drivers = start.drivers.slice(0, cap);
  counts.truncated = start.drivers.length > cap;
  const dropped = new Set<string>();
  for (const d of drivers) {
    const out = await db.withTenant(tenantId, async (q) => {
      await assertMembership(q, session);
      return draftDriver(q, session, start.period, d.id, start.findings, now);
    });
    if (out.kind === "locked") counts.locked += 1;
    else if (out.kind === "skipped") {
      counts.skipped += 1;
      if (out.removedId) dropped.add(out.removedId);
    } else {
      counts.drafts += 1;
      if (out.exception) counts.exceptions += 1;
      if (out.clean) counts.clean += 1;
    }
  }

  // A waiting card whose draft was removed is retired, in this run or in an earlier one that
  // stopped before this step; every other waiting card, of this week or any other, stays (a new
  // card for a changed draft already retired its old one).
  await db.withTenant(tenantId, async (q) => {
    await assertMembership(q, session);
    // The run lock first, as draftDriver takes it: no other run's draft and card can commit between
    // the read of the waiting cards and their locked read below, so a card made in between is never
    // retired. Both holders take this lock before any row lock, so waiting on it cannot deadlock.
    await tenantLock(q, "settlement_run");
    const waiting = await q.query<{ subject_id: string }>(
      `SELECT p.subject_id FROM proposals p
        WHERE p.tenant_id = current_tenant_id() AND p.origin = 'engine' AND p.kind = 'settlement_approve'
          AND p.status = 'proposed'
          AND EXISTS (SELECT 1 FROM settlements s
                       WHERE s.tenant_id = p.tenant_id AND s.id = p.subject_id)`,
    );
    const keep = new Set(waiting.map((w) => w.subject_id).filter((id) => !dropped.has(id)));
    await retireEngineProposalsExcept(q, "settlement_approve", keep, session, now);
  });
  return { ok: true, periodId: start.period.id, counts };
}
