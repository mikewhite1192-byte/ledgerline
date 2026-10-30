import { randomUUID } from "node:crypto";
import { screenUntrustedInput } from "../agent/gateway/screen";
import { runTriage, triageTarget, type TriageResult as SortResult } from "../agent/gateway/triage/run";
import type { CompleteFn, GatewayContext } from "../agent/gateway/types";
import { modelIdFor } from "../ai/targets";
import type { Session } from "../auth/claims";
import type { TenantRows } from "../data/rows";
import type { Queryable, TenantDb } from "../db";
import { receiveMessage, SORT_PURPOSE, STEP_BUDGET_MS } from "../inbound/pipeline";
import { readStep } from "../inbound/store";
import { readTenantZone } from "../money/read";
import { compareText } from "../rules-engine";
import { UNTRUSTED_SEED_KEYS } from "../seed/untrusted-inputs";
import { assertMembership } from "../tenant/context";
import { SEEDED_TRIAGE, TRIAGE_CASES, type TriageCase } from "./triage-cases";
import type { ScreenResult, SparkOpenResults, TriageResult } from "./types";

// Muse Spark Open's own numbers (design 4.5): one screen of each of the 12 seeded outside texts
// (the 4 planted injections should come back flagged, the 8 ordinary emails clean), and one
// triage of each of those 12 plus the 14 fixed emails in ./triage-cases.ts. Each call gets its own
// trace, so its cost and time are read back from model_calls by that trace. Only verdicts,
// booleans, cents and milliseconds come out; no message or model text.

export type SparkOpenCarrier = { slug: string; session: Session; rows: TenantRows };

export type SparkOpenDeps = {
  // The seeded carriers; the fixed emails go to the first one.
  carriers: readonly SparkOpenCarrier[];
  db: TenantDb;
  complete: CompleteFn;
  clock: () => number;
  newId?: () => string;
};

function inTenant<T>(db: TenantDb, session: Session, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

const CALLS_SQL =
  "SELECT count(*) AS calls, COALESCE(SUM(cost_nanocents), 0) AS cost, COALESCE(SUM(duration_ms), 0) AS ms" +
  " FROM model_calls WHERE tenant_id = current_tenant_id() AND trace_id = CAST($1 AS uuid)";

async function callsOf(db: TenantDb, session: Session, traceId: string): Promise<{ costNanocents: number; latencyMs: number | null }> {
  const [row] = await inTenant(db, session, (q) =>
    q.query<{ calls: string | number; cost: string | number; ms: string | number }>(CALLS_SQL, [traceId]),
  );
  const calls = Number(row?.calls ?? 0);
  const cost = Number(row?.cost ?? 0);
  const ms = Number(row?.ms ?? 0);
  if (![calls, cost, ms].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("a model call row is not whole");
  return { costNanocents: cost, latencyMs: calls === 0 ? null : ms };
}

async function contextFor(d: SparkOpenDeps, session: Session, traceId: string): Promise<GatewayContext> {
  const timeZone = await inTenant(d.db, session, (q) => readTenantZone(q));
  const now = d.clock();
  return {
    session,
    role: "triage",
    model: "spark_open",
    turnId: null,
    traceId,
    now: new Date(now),
    deadlineAt: now + STEP_BUDGET_MS,
    timeZone,
  };
}

const sameDates = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// A sort that did not decide (no valid classify_message call) is never right: its "other" is the
// fallback, not the model's answer.
function sortScore(
  sorted: SortResult,
  expected: { category: string; amountCents?: number | null; dates?: readonly string[] },
): Pick<TriageResult, "categoryRight" | "amountRight" | "datesRight"> {
  const amountApplies = expected.amountCents !== undefined;
  const datesApply = expected.dates !== undefined;
  if (!sorted.decided) {
    return { categoryRight: false, amountRight: amountApplies ? false : null, datesRight: datesApply ? false : null };
  }
  return {
    categoryRight: sorted.category === expected.category,
    amountRight: amountApplies ? (sorted.amountCents ?? null) === expected.amountCents : null,
    datesRight: datesApply && expected.dates ? sameDates(sorted.dates ?? [], expected.dates) : null,
  };
}

const errName = (err: unknown) => (err instanceof Error ? err.name : "unknown");

async function screenSeeded(d: SparkOpenDeps, c: SparkOpenCarrier, key: string, inputId: string): Promise<ScreenResult> {
  const traceId = (d.newId ?? randomUUID)();
  const expected = key.startsWith("inj-") ? "flagged" : "clean";
  let verdict: ScreenResult["verdict"] = null;
  try {
    const outcome = await screenUntrustedInput(await contextFor(d, c.session, traceId), inputId, {
      db: d.db,
      clock: d.clock,
      complete: d.complete,
    });
    // A screen that could not finish is not a verdict.
    verdict = outcome.verdict.via === "error" ? null : outcome.verdict.verdict;
  } catch (err) {
    console.error(`eval: screen of ${c.slug}-${key} failed: ${errName(err)}`);
  }
  return { key: `${c.slug}-${key}`, expected, verdict, ...(await callsOf(d.db, c.session, traceId)) };
}

async function triageSeeded(d: SparkOpenDeps, c: SparkOpenCarrier, key: string, inputId: string, text: string): Promise<TriageResult> {
  const traceId = (d.newId ?? randomUUID)();
  const expected = SEEDED_TRIAGE[key];
  let scored: Pick<TriageResult, "categoryRight" | "amountRight" | "datesRight"> = {
    categoryRight: null,
    amountRight: null,
    datesRight: null,
  };
  try {
    const sorted = await runTriage(
      await contextFor(d, c.session, traceId),
      { text, inputId, purpose: SORT_PURPOSE },
      { db: d.db, clock: d.clock, complete: d.complete },
    );
    if (expected) scored = sortScore(sorted, expected);
  } catch (err) {
    console.error(`eval: triage of ${c.slug}-${key} failed: ${errName(err)}`);
  }
  return { key: `${c.slug}-${key}`, ...scored, driverRight: null, ...(await callsOf(d.db, c.session, traceId)) };
}

// One fixed email through the Inbox's own receive step (the sender is matched to a driver there),
// then the triage call on the stored text and trace.
async function triageFixed(d: SparkOpenDeps, c: SparkOpenCarrier, t: TriageCase): Promise<TriageResult> {
  const newId = d.newId ?? randomUUID;
  const drivers = [...c.rows.drivers].sort((a, b) => compareText(a.code, b.code));
  if (drivers.length === 0) throw new Error("the carrier has no drivers for the triage emails");
  const driver = drivers[t.driver % drivers.length];
  const id = newId();
  const unknown: TriageResult = {
    key: `fixed-${t.key}`,
    categoryRight: null,
    amountRight: null,
    datesRight: null,
    driverRight: null,
    latencyMs: null,
    costNanocents: 0,
  };
  const received = await receiveMessage(
    c.session,
    {
      id,
      channel: "email",
      text: t.text,
      fromAddress: driver.email,
      subject: t.subject,
      receivedAt: new Date(d.clock()),
      messageId: `eval-${t.key}-${id}`,
    },
    { db: d.db, clock: d.clock, newId },
  );
  if (!received.ok) {
    console.error(`eval: triage email ${t.key} not stored: ${received.category}`);
    return unknown;
  }
  const step = await inTenant(d.db, c.session, (q) => readStep(q, id));
  if (!step || !step.input_id || step.body_text === null) return unknown;
  const driverRight = received.message.driverId === driver.id;
  let scored: Pick<TriageResult, "categoryRight" | "amountRight" | "datesRight"> = {
    categoryRight: null,
    amountRight: null,
    datesRight: null,
  };
  try {
    const sorted = await runTriage(
      await contextFor(d, c.session, step.trace_id),
      { text: step.body_text, inputId: step.input_id, purpose: SORT_PURPOSE },
      { db: d.db, clock: d.clock, complete: d.complete },
    );
    scored = sortScore(sorted, t);
  } catch (err) {
    console.error(`eval: triage of email ${t.key} failed: ${errName(err)}`);
  }
  return { key: `fixed-${t.key}`, ...scored, driverRight, ...(await callsOf(d.db, c.session, step.trace_id)) };
}

export async function runSparkOpen(d: SparkOpenDeps): Promise<SparkOpenResults> {
  const screens: ScreenResult[] = [];
  const triage: TriageResult[] = [];
  for (const c of d.carriers) {
    for (const key of UNTRUSTED_SEED_KEYS) {
      const input = c.rows.untrusted_inputs.find((u) => u.seed_key === `${c.slug}-${key}`);
      if (!input) throw new Error(`the seed has no untrusted input ${c.slug}-${key}`);
      screens.push(await screenSeeded(d, c, key, input.id));
      triage.push(await triageSeeded(d, c, key, input.id, input.body_text));
    }
  }
  const first = d.carriers[0];
  if (first) for (const t of TRIAGE_CASES) triage.push(await triageFixed(d, first, t));
  const sorter = triageTarget();
  return {
    screenTarget: modelIdFor("spark_open") || "spark_open",
    triageTarget: modelIdFor(sorter) || sorter,
    screens,
    triage,
  };
}
