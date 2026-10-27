import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import type { Session } from "../auth/claims";
import { readCheckInput, readTenant } from "../data/read";
import { getDb, type Queryable, type TenantDb } from "../db";
import { InputError } from "../rules-engine";
import { runFuelChecks, type FuelFinding } from "../rules-engine/fuel";
import { assertMembership, ForbiddenError } from "../tenant/context";
import { isLocalDate, localDateOf } from "../time/local-date";
import {
  COMPARE_PURPOSE,
  compareReceipts,
  pairPhotos,
  type CompareDeps,
  type CompareOutcome,
  type ComparePhoto,
} from "./compare";

// One fuel check (FUEL-ANOMALY design 3.1). The engine pass is one transaction: the run row, every
// finding upserted by its finding_key, and the open ones the engine no longer finds cleared. A
// failure anywhere in it leaves no finding and no partial run behind; a failed run row is written
// on its own after, with a category. Then, outside that transaction, the receipt compares for
// "same receipt turned in twice", each its own call and its own small conditional write, bounded
// per run and per carrier per day. Nothing here moves money or drafts a card.

// A run left running this long (its request died) is given up, so the carrier can check again.
const ABANDONED_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
// A compare answer that may still be tried again: no photos, the budget or a timeout.
const RETRYABLE = "compare_verdict IS NULL OR (compare_verdict = 'unknown' AND compare_category IN ('budget', 'timeout', 'no_photos'))";

export type FuelRunDeps = CompareDeps & { db?: TenantDb; clock?: () => Date };

export type FuelRunResult =
  | { ok: true; runId: string; checked: number; needYou: number }
  // failed: nothing was written but the failed run row. unknown: the findings were written but the
  // run could not be closed, so the page asks the person to look before trying again.
  | { ok: false; category: "disabled" | "not_configured" | "busy" | "failed" | "unknown" };

function limitsOk(): boolean {
  const l = flags.fuelAnomalyLimits;
  const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
  const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
  return (
    isLocalDate(l.from) &&
    positive(l.duplicateWindowMinutes) &&
    positive(l.chargebackMaxCents) &&
    positive(l.compareMaxCostCents) &&
    positive(l.compareMaxOutputTokens) &&
    count(l.comparesPerRun) &&
    count(l.comparesPerTenantPerDay)
  );
}

type Pass = { checked: number; found: number };

export async function runFuelCheck(session: Session, deps: FuelRunDeps = {}): Promise<FuelRunResult> {
  // The switch is read here, not only by the route.
  if (!flags.fuelAnomalyEnabled) return { ok: false, category: "disabled" };
  if (!limitsOk()) return { ok: false, category: "not_configured" };
  const limits = flags.fuelAnomalyLimits;
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const nowIso = now.toISOString();
  const runId = randomUUID();

  let pass: Pass | "busy";
  try {
    pass = await db.withTenant(session.tenantId, (q) => enginePass(q, session, runId, now, limits));
  } catch (err) {
    if (err instanceof ForbiddenError) throw err;
    const category = err instanceof InputError ? "unreadable" : "unavailable";
    console.error(`fuel: run ${runId} failed category=${category}`);
    await db
      .withTenant(session.tenantId, (q) =>
        q.execute(
          `INSERT INTO fuel_check_runs (id, tenant_id, started_by, status, fail_category, started_at, finished_at)
           VALUES (CAST($1 AS uuid), current_tenant_id(), $2, 'failed', $3, CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
          [runId, session.sub, category, nowIso],
        ),
      )
      .catch(() => console.error(`fuel: run ${runId} could not record its failure`));
    return { ok: false, category: "failed" };
  }
  if (pass === "busy") return { ok: false, category: "busy" };

  let spent = { calls: 0, knownNanocents: 0, unknownCost: 0 };
  try {
    spent = await compareDuplicates(db, session, runId, now, deps);
  } catch {
    // Each compare's write stands on its own; one that failed is tried again by a later run.
    console.error(`fuel: run ${runId} compares stopped category=unavailable`);
  }

  try {
    const spentCents =
      Math.ceil(spent.knownNanocents / NANOCENTS_PER_CENT) + spent.unknownCost * limits.compareMaxCostCents;
    const needYou = await db.withTenant(session.tenantId, async (q) => {
      const closed = await q.execute(
        `UPDATE fuel_check_runs
            SET status = 'done', compare_count = $2, spent_cents = $3, finished_at = CAST($4 AS timestamptz)
          WHERE id = CAST($1 AS uuid) AND status = 'running'`,
        [runId, spent.calls, spentCents, clock().toISOString()],
      );
      if (closed !== 1) throw new Error("the fuel run did not close");
      const open = await q.query<{ n: number | string }>(
        "SELECT count(*) AS n FROM fuel_findings WHERE status = 'open'",
      );
      return Number(open[0]?.n ?? 0);
    });
    return { ok: true, runId, checked: pass.checked, needYou };
  } catch {
    console.error(`fuel: run ${runId} could not close category=unavailable`);
    return { ok: false, category: "unknown" };
  }
}

async function enginePass(
  q: Queryable,
  session: Session,
  runId: string,
  now: Date,
  limits: typeof flags.fuelAnomalyLimits,
): Promise<Pass | "busy"> {
  await assertMembership(q, session);
  const nowIso = now.toISOString();
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant row");
  const asOf = localDateOf(nowIso, tenant.timezone);

  await q.execute(
    `UPDATE fuel_check_runs
        SET status = 'failed', fail_category = 'abandoned', finished_at = CAST($1 AS timestamptz)
      WHERE status = 'running' AND started_at < CAST($2 AS timestamptz)`,
    [nowIso, new Date(now.getTime() - ABANDONED_MS).toISOString()],
  );
  // One running run per carrier (a partial unique index): a second click finds none inserted.
  const inserted = await q.execute(
    `INSERT INTO fuel_check_runs (id, tenant_id, as_of, started_by, started_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), $3, CAST($4 AS timestamptz))
     ON CONFLICT DO NOTHING`,
    [runId, asOf, session.sub, nowIso],
  );
  if (inserted !== 1) return "busy";

  const input = await readCheckInput(q);
  const findings = runFuelChecks(input, limits);
  const checked = input.fuelPurchases.filter((p) => p.purchasedOn >= limits.from).length;

  // A card that was rejected, expired or failed lets its finding go back to the person.
  await q.execute(
    `UPDATE fuel_findings f
        SET status = 'open', proposal_id = NULL, updated_at = CAST($1 AS timestamptz)
       FROM proposals p
      WHERE p.tenant_id = f.tenant_id AND p.id = f.proposal_id AND f.status = 'proposed'
        AND p.status IN ('rejected', 'expired', 'failed')`,
    [nowIso],
  );
  for (const f of findings) await upsertFinding(q, f, runId, nowIso);
  // An open finding the engine no longer finds is cleared; a person's decision is never undone.
  await q.execute(
    `UPDATE fuel_findings SET status = 'cleared', updated_at = CAST($2 AS timestamptz)
      WHERE status = 'open' AND last_run_id <> CAST($1 AS uuid)`,
    [runId, nowIso],
  );
  const counted = await q.execute(
    `UPDATE fuel_check_runs SET checked_count = $2, found_count = $3
      WHERE id = CAST($1 AS uuid) AND status = 'running'`,
    [runId, checked, findings.length],
  );
  if (counted !== 1) throw new Error("the fuel run did not read back");
  return { checked, found: findings.length };
}

// Insert a new finding open, or refresh the live fields of the one with the same key. Its status
// never changes here, except that a cleared finding found again is open again.
async function upsertFinding(q: Queryable, f: FuelFinding, runId: string, nowIso: string): Promise<void> {
  await q.execute(
    `INSERT INTO fuel_findings
       (id, tenant_id, finding_key, check_name, category, driver_id, fuel_purchase_id, other_purchase_id,
        load_id, pay_item_id, purchased_on, state, gallons_milli, tank_gallons, paid_with, amount_cents,
        excess_cents, suggested_cents, no_suggestion, sources, first_run_id, last_run_id, created_at, updated_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, CAST($5 AS uuid), CAST($6 AS uuid), CAST($7 AS uuid),
             CAST($8 AS uuid), CAST($9 AS uuid), CAST($10 AS date), $11, $12, $13, $14, $15,
             $16, $17, $18, CAST($19 AS jsonb), CAST($20 AS uuid), CAST($20 AS uuid),
             CAST($21 AS timestamptz), CAST($21 AS timestamptz))
     ON CONFLICT (tenant_id, finding_key) DO UPDATE SET
       load_id = EXCLUDED.load_id,
       pay_item_id = EXCLUDED.pay_item_id,
       purchased_on = EXCLUDED.purchased_on,
       state = EXCLUDED.state,
       gallons_milli = EXCLUDED.gallons_milli,
       tank_gallons = EXCLUDED.tank_gallons,
       paid_with = EXCLUDED.paid_with,
       amount_cents = EXCLUDED.amount_cents,
       excess_cents = EXCLUDED.excess_cents,
       suggested_cents = EXCLUDED.suggested_cents,
       no_suggestion = EXCLUDED.no_suggestion,
       sources = EXCLUDED.sources,
       last_run_id = EXCLUDED.last_run_id,
       updated_at = EXCLUDED.updated_at,
       status = CASE WHEN fuel_findings.status = 'cleared' THEN 'open' ELSE fuel_findings.status END`,
    [
      randomUUID(),
      f.findingKey,
      f.check,
      f.category,
      f.driverId,
      f.fuelPurchaseId,
      f.otherPurchaseId,
      f.loadId,
      f.payItemId,
      f.purchasedOn,
      f.state,
      f.gallonsMilli,
      f.tankGallons,
      f.paidWith,
      f.amountCents,
      f.excessCents,
      f.suggestedCents,
      f.noSuggestion,
      JSON.stringify(f.sources.map((s) => ({ table: s.table, id: s.id }))),
      runId,
      nowIso,
    ],
  );
}

type Candidate = {
  id: string;
  amount_cents: number | string;
  gallons_milli: number;
  purchased_on: string;
  truck_unit: string | null;
};

type Spent = { calls: number; knownNanocents: number; unknownCost: number };

// The receipt compares: duplicates still undecided or worth trying again, open or sent for
// approval. The allowance is the smaller of the run's bound and what is left of the carrier's day
// (counted from the model call ledger by purpose, so a call that never answered still counts).
async function compareDuplicates(
  db: TenantDb,
  session: Session,
  runId: string,
  now: Date,
  deps: FuelRunDeps,
): Promise<Spent> {
  const limits = flags.fuelAnomalyLimits;
  const nowIso = now.toISOString();
  const plan = await db.withTenant(session.tenantId, async (q) => {
    const candidates = await q.query<Candidate>(
      `SELECT f.id, f.amount_cents, f.gallons_milli, CAST(f.purchased_on AS text) AS purchased_on, d.truck_unit
         FROM fuel_findings f
         JOIN drivers d ON d.tenant_id = f.tenant_id AND d.id = f.driver_id
        WHERE f.check_name = 'fuel_duplicate' AND f.status IN ('open', 'proposed') AND (${RETRYABLE})
        ORDER BY f.purchased_on, f.finding_key`,
    );
    const used = await q.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM model_calls
        WHERE purpose = $1 AND created_at > CAST($2 AS timestamptz) AND created_at <= CAST($3 AS timestamptz)`,
      [COMPARE_PURPOSE, new Date(now.getTime() - DAY_MS).toISOString(), nowIso],
    );
    const usedToday = Number(used[0]?.n ?? 0);
    let allowance = Math.max(0, Math.min(limits.comparesPerRun, limits.comparesPerTenantPerDay - usedToday));
    const calls: { id: string; photos: ComparePhoto[] }[] = [];
    for (const c of candidates) {
      const photos = await pairPhotos(q, {
        amountCents: Number(c.amount_cents),
        gallonsMilli: c.gallons_milli,
        purchasedOn: c.purchased_on,
        truckUnit: c.truck_unit,
      });
      if (!photos) {
        await keepCompare(q, c.id, { verdict: "unknown", category: "no_photos" }, [], nowIso);
      } else if (allowance > 0) {
        allowance -= 1;
        calls.push({ id: c.id, photos });
      } else {
        await keepCompare(q, c.id, { verdict: "unknown", category: "budget" }, [], nowIso);
      }
    }
    return calls;
  });

  const outcomes = await Promise.all(
    plan.map(async (c) => {
      const [a, b] = c.photos;
      const outcome = await compareReceipts({ findingId: c.id, photos: [a, b], traceId: runId }, session, {
        complete: deps.complete,
        ai: deps.ai ?? { db },
      });
      return { id: c.id, docs: [a.id, b.id], outcome };
    }),
  );

  const spent: Spent = { calls: 0, knownNanocents: 0, unknownCost: 0 };
  for (const { id, docs, outcome } of outcomes) {
    if (outcome.verdict === "off") continue;
    spent.calls += 1;
    if (outcome.costNanocents === null) spent.unknownCost += 1;
    else spent.knownNanocents += outcome.costNanocents;
    try {
      await db.withTenant(session.tenantId, (q) => keepCompare(q, id, outcome, docs, clockIso(deps)));
    } catch {
      console.error(`fuel: compare for ${id} not kept category=unavailable`);
    }
  }
  return spent;
}

function clockIso(deps: FuelRunDeps): string {
  return (deps.clock ?? (() => new Date()))().toISOString();
}

type Kept =
  | Exclude<CompareOutcome, { verdict: "off" }>
  | { verdict: "unknown"; category: "no_photos" | "budget"; callId?: undefined };

// One conditional write: only a finding whose compare may still be tried again takes an answer, so
// a final answer is never overwritten and two runs never both write one.
async function keepCompare(q: Queryable, id: string, kept: Kept, docs: string[], nowIso: string): Promise<number> {
  const confidence = kept.verdict === "unknown" ? null : kept.confidence;
  const category = kept.verdict === "unknown" ? kept.category : null;
  return q.execute(
    `UPDATE fuel_findings
        SET compare_verdict = $2, compare_confidence = $3, compare_category = $4,
            compare_call_id = CAST($5 AS uuid), compare_document_ids = CAST($6 AS jsonb),
            updated_at = CAST($7 AS timestamptz)
      WHERE id = CAST($1 AS uuid) AND check_name = 'fuel_duplicate' AND (${RETRYABLE})`,
    [
      id,
      kept.verdict,
      confidence,
      category,
      kept.callId ?? null,
      JSON.stringify(docs),
      nowIso,
    ],
  );
}
