import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { CompleteFn } from "../agent/gateway/types";
import { complete as aiComplete } from "../ai";
import { NANOCENTS_PER_CENT } from "../ai/prices";
import type { Session } from "../auth/claims";
import {
  MAX_STATEMENT_ROWS,
  countOpenBreaks,
  readBreak,
  readCandidateFacts,
  readCardLoads,
  readCardsOnFile,
  readMatchFacts,
  readRun,
  readStatement,
  readStatementPurchases,
  type RunView,
} from "../data/card-recon";
import { getDb, type Queryable, type TenantDb } from "../db";
import { tenantLock } from "../invoices/number";
import { resolveDeps, type MoneyDeps } from "../money/execute";
import { readAction, readSentInWindow, readTenantZone } from "../money/read";
import type { MoneyAction } from "../money/types";
import { retireEngineProposalsExcept } from "../proposals/engine";
import {
  SEVERITY_OF,
  checkWindow,
  compareReadBack,
  fingerprintOf,
  rankCandidates,
  reconcileStatement,
  sentInWindow,
  topIsTied,
  type BreakCategory,
  type LedgerFact,
  type ReadOutcome,
  type ReconBreak,
} from "../rules-engine/card-recon";
import { ForbiddenError, assertMembership } from "../tenant/context";
import { localDateOf } from "../time/local-date";
import { isUuid } from "../uuid";
import { EXPLAIN_TIMEOUT_MS, explainBreak } from "./explain";
import { MATCH_TIMEOUT_MS, persistMatch, pickDriver, type Picked } from "./match";
import { readHooks, readOneBack, systemKey, systemOf, systemReady, type ReadHooks } from "./readback";
import { recordWords } from "./words";

// The card check (design 4.3): one press compares the card provider's statement (Test mode: the
// seeded card_transactions) with our fuel purchases, card loads and cards on file, and reads every
// payment record of the window back from its own system. Each difference is a break, one row per
// fingerprint, with a plain sentence and a fix. It reads and proposes only: the one write outside
// its own tables is a match card (an engine proposal) a person approves or rejects.
//
// A run works in slices, one request each, under a lease, so a request never runs past the
// platform's limit and two workers never touch one run:
//   start    one transaction under the carrier's card_check lock: the statement compared, its
//            breaks written, the window's payment records listed (todo);
//   read     a few records per step, read back in parallel outside any transaction (each under
//            its own time limit, at most maxReadBacksPerSystem per system, a system whose switch
//            or connection is off skipped with one "not connected" line), then compared;
//   explain  one model sentence per new or changed open break, counted against the run's cap
//            before the call; past the cap, or on any failure, the page shows the fixed sentence;
//   match    one model pick per unknown card with a clear top candidate; a valid pick becomes a
//            match card;
//   done     waiting match cards whose card is no longer unknown are retired; counts.
// Every write re-checks the lease token. An outside read's answer is never taken as known when it
// threw or timed out: that record is listed as not checked, and its earlier breaks stay as they are.

export type CardCheckDeps = {
  db?: TenantDb;
  clock?: () => Date;
  money?: Partial<MoneyDeps>;
  complete?: CompleteFn;
  newId?: () => string;
};

export type StartResult = { ok: true; runId: string; resumed: boolean } | { ok: false; category: "disabled" };

export type AdvanceResult =
  | { ok: true; run: RunView }
  | { ok: false; category: "disabled" | "bad_request" | "not_found" };

export type DismissResult = { ok: true } | { ok: false; category: "disabled" | "bad_request" | "not_found" };

export const DISMISS_CATEGORIES = ["explained", "duplicate", "wrong_system", "other"] as const;
export type DismissCategory = (typeof DISMISS_CATEGORIES)[number];

// Longer than the route's own 30 s limit, so no step outlives its lease while its request is alive.
export const LEASE_S = 45;
const ABANDONED_MS = 10 * 60_000;
export const READ_BATCH = 8;
export const MAX_LEDGER_ROWS = 1_000;
export const MAX_STATEMENT_BREAKS = 500;
// The start's writes go a set at a time, at most this many rows per statement. A break is at most
// about half a kilobyte as JSON, so a statement's one parameter stays near 50 KB, the size of the
// run's own list of 1,000 record ids (about 40 KB) and far from the large writes the Data API is
// not proven with. A full window is a few dozen round trips instead of one or two per record.
export const WRITE_BATCH = 100;
const MAX_LINES = 20;

const STATEMENT_CATEGORIES: readonly BreakCategory[] = [
  "fuel_amount_differs",
  "purchase_not_recorded",
  "card_unknown",
  "load_not_in_ledger",
  "load_amount_differs",
];
const LEDGER_CATEGORIES: readonly BreakCategory[] = [
  "missing_outside",
  "reversed_outside",
  "amount_differs_outside",
  "pending_outside",
  "not_confirmed",
];
// Constants only (checked), so the list can sit in the SQL text.
const sqlList = (values: readonly string[]): string => {
  for (const v of values) if (!/^[a-z_]+$/.test(v)) throw new Error("not a category");
  return values.map((v) => `'${v}'`).join(", ");
};
const SEVERITY_ORDER = "CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END";
const RANK: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };

type Line = { system: string; category: string };

type Counts = {
  statement: number;
  statementBreaks: number;
  records: number;
  recordsRead: number;
  recordsClean: number;
  recordBreaks: number;
  notConnected: number;
  notChecked: number;
  explained: number;
  matchCards: number;
  needsYou: number;
  notConfirmed: number;
  readBySystem: Record<string, number>;
  // The statement's total, its open differences by category and the ones a person dismissed, set
  // at the start and at the end; a run without them has no verdict.
  statementCents?: number;
  statementOpen?: Partial<Record<BreakCategory, number>>;
  statementClosed?: number;
};

const emptyCounts = (): Counts => ({
  statement: 0,
  statementBreaks: 0,
  records: 0,
  recordsRead: 0,
  recordsClean: 0,
  recordBreaks: 0,
  notConnected: 0,
  notChecked: 0,
  explained: 0,
  matchCards: 0,
  needsYou: 0,
  notConfirmed: 0,
  readBySystem: {},
});

type RunRow = {
  status: string;
  phase: string;
  todo: string[];
  counts: Counts;
  unchecked: Line[];
};

class LeaseLost extends Error {
  constructor() {
    super("the card check's lease moved to another worker");
    this.name = "LeaseLost";
  }
}

type Ctx = {
  db: TenantDb;
  session: Session;
  tenantId: string;
  runId: string;
  token: string;
  clock: () => Date;
  deadlineAt: number;
  money: MoneyDeps;
  complete: CompleteFn;
  ready: Map<string, { ok: true } | { ok: false; category: string }>;
  hooks: Partial<Record<MoneyAction["kind"], ReadHooks>> | null;
};

const centsOfNano = (nano: number) => Math.max(0, Math.ceil(nano / NANOCENTS_PER_CENT));

function parseJson(text: unknown): unknown {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

function countsOf(text: unknown): Counts {
  const v = parseJson(text);
  const out = emptyCounts();
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(out) as (keyof Counts)[]) {
    if (k === "readBySystem") continue;
    const n = o[k];
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) (out[k] as number) = n;
  }
  const by = o.readBySystem;
  if (by && typeof by === "object" && !Array.isArray(by)) {
    for (const [k, n] of Object.entries(by as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) out.readBySystem[k] = n;
    }
  }
  if (typeof o.statementCents === "number" && Number.isSafeInteger(o.statementCents) && o.statementCents >= 0) {
    out.statementCents = o.statementCents;
  }
  const open = statementOpenOf(o.statementOpen);
  if (open) out.statementOpen = open;
  if (typeof o.statementClosed === "number" && Number.isSafeInteger(o.statementClosed) && o.statementClosed >= 0) {
    out.statementClosed = o.statementClosed;
  }
  return out;
}

// The open differences by statement category, or null when any entry is not a whole count of a
// statement category.
function statementOpenOf(value: unknown): Partial<Record<BreakCategory, number>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Partial<Record<BreakCategory, number>> = {};
  for (const [k, n] of Object.entries(value as Record<string, unknown>)) {
    if (!(STATEMENT_CATEGORIES as readonly string[]).includes(k)) return null;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
    out[k as BreakCategory] = n;
  }
  return out;
}

function linesOf(text: unknown): Line[] {
  const v = parseJson(text);
  if (!Array.isArray(v)) return [];
  return v
    .filter((l): l is Line => !!l && typeof l === "object" && typeof l.system === "string" && typeof l.category === "string")
    .slice(0, MAX_LINES);
}

function idsOf(text: unknown): string[] {
  const v = parseJson(text);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && isUuid(x)) : [];
}

function addLine(lines: Line[], line: Line): void {
  if (lines.length >= MAX_LINES) return;
  if (!lines.some((l) => l.system === line.system && l.category === line.category)) lines.push(line);
}

async function readRunRow(q: Queryable, runId: string): Promise<RunRow | null> {
  const rows = await q.query<Record<string, unknown>>(
    `SELECT status, phase, CAST(todo AS text) AS todo, CAST(counts AS text) AS counts,
            CAST(unchecked AS text) AS unchecked
       FROM card_recon_runs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [runId],
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  return {
    status: String(r.status),
    phase: String(r.phase),
    todo: idsOf(r.todo),
    counts: countsOf(r.counts),
    unchecked: linesOf(r.unchecked),
  };
}

// The rows of one statement each: at most WRITE_BATCH, and, given a key, no key twice in one
// statement (a key seen again starts the next one), so every row lands as it would one at a time.
function batches<T>(rows: readonly T[], keyOf?: (row: T) => string): T[][] {
  const out: T[][] = [];
  let part: T[] = [];
  const keys = new Set<string>();
  for (const row of rows) {
    const key = keyOf?.(row);
    if (part.length >= WRITE_BATCH || (key !== undefined && keys.has(key))) {
      out.push(part);
      part = [];
      keys.clear();
    }
    part.push(row);
    if (key !== undefined) keys.add(key);
  }
  if (part.length > 0) out.push(part);
  return out;
}

type NewBreak = { b: ReconBreak; id: string };

// One break per fingerprint. A break seen again keeps its explanation unless an amount moved,
// keeps its match card's fix while it has one, reopens when it had been resolved, and stays
// dismissed when a person dismissed it. One statement per batch of breaks.
async function upsertBreaks(q: Queryable, rows: readonly NewBreak[], runId: string, nowIso: string): Promise<void> {
  const items = rows.map(({ b, id }) => ({
    id,
    fingerprint: fingerprintOf(b),
    category: b.category,
    severity: b.severity,
    outside_system: b.outsideSystem,
    card_transaction_id: b.cardTransactionId,
    money_action_id: b.moneyActionId,
    fuel_purchase_id: b.fuelPurchaseId,
    driver_id: b.driverId,
    our_cents: b.ourCents,
    outside_cents: b.outsideCents,
    fix_kind: b.fixKind,
  }));
  for (const part of batches(items, (i) => i.fingerprint)) {
    await q.execute(
      `INSERT INTO card_recon_breaks
         (id, tenant_id, fingerprint, category, severity, outside_system, card_transaction_id,
          money_action_id, fuel_purchase_id, driver_id, our_cents, outside_cents, fix_kind,
          first_seen_run_id, last_seen_run_id, created_at, updated_at)
       SELECT r.id, current_tenant_id(), r.fingerprint, r.category, r.severity, r.outside_system,
              r.card_transaction_id, r.money_action_id, r.fuel_purchase_id, r.driver_id, r.our_cents,
              r.outside_cents, r.fix_kind, CAST($2 AS uuid), CAST($2 AS uuid), CAST($3 AS timestamptz),
              CAST($3 AS timestamptz)
         FROM jsonb_to_recordset(CAST($1 AS jsonb))
           AS r(id uuid, fingerprint text, category text, severity text, outside_system text,
                card_transaction_id uuid, money_action_id uuid, fuel_purchase_id uuid, driver_id uuid,
                our_cents bigint, outside_cents bigint, fix_kind text)
       ON CONFLICT (tenant_id, fingerprint) DO UPDATE SET
         severity = EXCLUDED.severity,
         outside_system = EXCLUDED.outside_system,
         driver_id = EXCLUDED.driver_id,
         explanation = CASE WHEN card_recon_breaks.our_cents IS DISTINCT FROM EXCLUDED.our_cents
                              OR card_recon_breaks.outside_cents IS DISTINCT FROM EXCLUDED.outside_cents
                            THEN NULL ELSE card_recon_breaks.explanation END,
         explain_category = CASE WHEN card_recon_breaks.our_cents IS DISTINCT FROM EXCLUDED.our_cents
                                   OR card_recon_breaks.outside_cents IS DISTINCT FROM EXCLUDED.outside_cents
                                 THEN NULL ELSE card_recon_breaks.explain_category END,
         our_cents = EXCLUDED.our_cents,
         outside_cents = EXCLUDED.outside_cents,
         fix_kind = CASE WHEN card_recon_breaks.proposal_id IS NOT NULL THEN card_recon_breaks.fix_kind
                         ELSE EXCLUDED.fix_kind END,
         status = CASE WHEN card_recon_breaks.status = 'dismissed' THEN 'dismissed' ELSE 'open' END,
         resolved_at = CASE WHEN card_recon_breaks.status = 'dismissed' THEN card_recon_breaks.resolved_at
                            ELSE NULL END,
         last_seen_run_id = EXCLUDED.last_seen_run_id,
         updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(part), runId, nowIso],
    );
  }
}

// A payment record and the one difference just found on it, if any (its fingerprint).
type RecordSeen = { id: string; keep: string | null };

// Closes the open breaks of the given categories on each payment record, all but the one just
// found on it (keep), when the record now reads clean or reads as that one difference. One
// statement per batch of records.
async function resolveRecordBreaks(
  q: Queryable,
  records: readonly RecordSeen[],
  categories: readonly BreakCategory[],
  nowIso: string,
): Promise<void> {
  for (const part of batches(records)) {
    await q.execute(
      `UPDATE card_recon_breaks AS b
          SET status = 'resolved', resolved_at = CAST($2 AS timestamptz), updated_at = CAST($2 AS timestamptz)
         FROM jsonb_to_recordset(CAST($1 AS jsonb)) AS r(id uuid, keep text)
        WHERE b.tenant_id = current_tenant_id() AND b.status = 'open' AND b.money_action_id = r.id
          AND b.category IN (${sqlList(categories)})
          AND (r.keep IS NULL OR b.fingerprint <> r.keep)`,
      [JSON.stringify(part), nowIso],
    );
  }
}

function ledgerFact(a: MoneyAction, d: MoneyDeps): LedgerFact {
  return {
    id: a.id,
    kind: a.kind,
    state: a.state,
    amountCents: a.amountCents,
    outsideSystem: systemOf(a, d),
    sentAt: a.sentAt,
  };
}

function bySeverity(breaks: readonly ReconBreak[]): ReconBreak[] {
  return [...breaks].sort((a, b) => RANK[SEVERITY_OF[a.category]] - RANK[SEVERITY_OF[b.category]]);
}

function moneyDeps(deps: CardCheckDeps): MoneyDeps {
  return resolveDeps({ ...deps.money, timeoutMs: flags.cardRecon.limits.readBackTimeoutMs });
}

// ---- Start ----

export async function startCardCheck(session: Session, deps: CardCheckDeps = {}): Promise<StartResult> {
  // The switch is read here, not only by the route.
  if (!flags.cardRecon.enabled) return { ok: false, category: "disabled" };
  const limits = flags.cardRecon.limits;
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const money = moneyDeps(deps);
  const now = clock();
  const nowIso = now.toISOString();
  const runId = newId().toLowerCase();

  return db.withTenant(session.tenantId, async (q): Promise<StartResult> => {
    await assertMembership(q, session);
    await tenantLock(q, "card_check");
    // A run nobody has carried on for ten minutes is given up, so a new one can start.
    await q.execute(
      `UPDATE card_recon_runs
          SET status = 'failed', fail_category = 'abandoned', phase = 'done', todo = '[]',
              lease_token = NULL, lease_until = NULL, finished_at = CAST($1 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND status = 'running'
          AND COALESCE(lease_until, started_at) < CAST($2 AS timestamptz)`,
      [nowIso, new Date(now.getTime() - ABANDONED_MS).toISOString()],
    );
    const running = await q.query<{ id: string }>(
      `SELECT CAST(id AS text) AS id FROM card_recon_runs
        WHERE tenant_id = current_tenant_id() AND status = 'running'`,
    );
    if (running.length > 0) return { ok: true, runId: running[0].id, resumed: true };
    const member = await q.query<{ id: string }>(
      `SELECT CAST(id AS text) AS id FROM memberships
        WHERE tenant_id = current_tenant_id() AND cognito_sub = $1`,
      [session.sub],
    );
    if (member.length !== 1) throw new ForbiddenError();
    const zone = await readTenantZone(q);
    const window = checkWindow(localDateOf(nowIso, zone), limits.windowDays);
    await q.execute(
      `INSERT INTO card_recon_runs (id, tenant_id, membership_id, window_from, window_to, started_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS date), CAST($4 AS date),
               CAST($5 AS timestamptz))`,
      [runId, member[0].id, window.start, window.end, nowIso],
    );

    // The statement against our records.
    const counts = emptyCounts();
    const lines: Line[] = [];
    const txns = await readStatement(q, window);
    const found = reconcileStatement({
      txns,
      purchases: await readStatementPurchases(q, window),
      cards: await readCardsOnFile(q),
      cardLoads: await readCardLoads(q, window),
      window,
    });
    counts.statement = txns.length;
    counts.statementCents = txns.reduce((sum, t) => sum + t.amountCents, 0);
    counts.statementBreaks = found.length;
    let whole = txns.length < MAX_STATEMENT_ROWS;
    if (!whole) addLine(lines, { system: "fuel_card_sim", category: "too_many_rows" });
    const kept = bySeverity(found).slice(0, MAX_STATEMENT_BREAKS);
    if (kept.length < found.length) {
      whole = false;
      addLine(lines, { system: "fuel_card_sim", category: "too_many_differences" });
    }
    await upsertBreaks(q, kept.map((b) => ({ b, id: newId() })), runId, nowIso);
    // A statement row that now matches closes what an earlier check found on it. Only when the
    // whole window was compared: a row left out is not a row that matched.
    if (whole) {
      await q.execute(
        `UPDATE card_recon_breaks
            SET status = 'resolved', resolved_at = CAST($4 AS timestamptz), updated_at = CAST($4 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND status = 'open'
            AND category IN (${sqlList(STATEMENT_CATEGORIES)})
            AND last_seen_run_id <> CAST($1 AS uuid)
            AND card_transaction_id IN (
              SELECT t.id FROM card_transactions t
               WHERE t.tenant_id = current_tenant_id()
                 AND t.posted_on BETWEEN CAST($2 AS date) AND CAST($3 AS date))`,
        [runId, window.start, window.end, nowIso],
      );
    }

    // The window's payment records, by the local date of each send in the carrier's zone. The read
    // takes that date before its limit, so a record outside the window never takes a place, and
    // too_many_records means the window alone reached the limit. The filter checks it again.
    const sent = await readSentInWindow(q, window.start, window.end, zone, MAX_LEDGER_ROWS);
    if (sent.length >= MAX_LEDGER_ROWS) addLine(lines, { system: "payment_records", category: "too_many_records" });
    const inWindow = sent.filter((a) => sentInWindow(a.sentAt, zone, window));
    counts.records = inWindow.length;
    const todo: string[] = [];
    const recordBreaks: NewBreak[] = [];
    const confirmedNow: RecordSeen[] = [];
    const settled: RecordSeen[] = [];
    for (const a of inWindow) {
      if (a.state === "confirmed") {
        // Confirmed now: an earlier "not confirmed yet" on it is closed; the read step compares it.
        todo.push(a.id);
        confirmedNow.push({ id: a.id, keep: null });
        continue;
      }
      const cmp = compareReadBack(ledgerFact(a, money), null);
      if (cmp.kind === "break") {
        recordBreaks.push({ b: cmp.break, id: newId() });
        settled.push({ id: a.id, keep: fingerprintOf(cmp.break) });
        counts.recordBreaks += 1;
      } else if (cmp.kind === "clean") {
        settled.push({ id: a.id, keep: null });
      }
    }
    // Written a set at a time. Every write here names one record's own breaks (its id is in the
    // break's fingerprint and in the filter), and the window lists each record once, so this order
    // leaves what one record at a time left: the difference just found open, the rest on that
    // record closed.
    await upsertBreaks(q, recordBreaks, runId, nowIso);
    await resolveRecordBreaks(q, confirmedNow, ["not_confirmed"], nowIso);
    await resolveRecordBreaks(q, settled, LEDGER_CATEGORIES, nowIso);
    await q.execute(
      `UPDATE card_recon_runs SET todo = CAST($2 AS jsonb), counts = CAST($3 AS jsonb), unchecked = CAST($4 AS jsonb)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [runId, JSON.stringify(todo), JSON.stringify(counts), JSON.stringify(lines)],
    );
    return { ok: true, runId, resumed: false };
  });
}

// ---- Advance ----

export async function advanceCardCheck(
  session: Session,
  runId: string,
  deadlineAt: number,
  deps: CardCheckDeps = {},
): Promise<AdvanceResult> {
  if (!flags.cardRecon.enabled) return { ok: false, category: "disabled" };
  if (!isUuid(runId) || !Number.isFinite(deadlineAt)) return { ok: false, category: "bad_request" };
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? (() => new Date());
  const token = randomUUID();
  const id = runId.toLowerCase();

  type Taken = { kind: "not_found" } | { kind: "final" | "busy"; run: RunView } | { kind: "run" };
  const taken = await db.withTenant(session.tenantId, async (q): Promise<Taken> => {
    await assertMembership(q, session);
    const run = await readRun(q, id);
    if (!run) return { kind: "not_found" };
    if (run.status !== "running") return { kind: "final", run };
    const got = await q.query<{ id: string }>(
      `UPDATE card_recon_runs
          SET lease_token = CAST($2 AS uuid), lease_until = CAST($3 AS timestamptz) + make_interval(secs => $4)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'running'
          AND (lease_until IS NULL OR lease_until <= CAST($3 AS timestamptz))
        RETURNING id`,
      [id, token, clock().toISOString(), LEASE_S],
    );
    // Another request is carrying the run on: the caller polls again.
    if (got.length !== 1) return { kind: "busy", run };
    return { kind: "run" };
  });
  if (taken.kind === "not_found") return { ok: false, category: "not_found" };
  if (taken.kind !== "run") return { ok: true, run: taken.run };

  const ctx: Ctx = {
    db,
    session,
    tenantId: session.tenantId,
    runId: id,
    token,
    clock,
    deadlineAt,
    money: moneyDeps(deps),
    complete: deps.complete ?? ((target, request, s) => aiComplete(target, request, s, { db })),
    ready: new Map(),
    hooks: null,
  };
  try {
    await slice(ctx);
  } catch (err) {
    if (!(err instanceof LeaseLost)) {
      await failRun(ctx).catch(() => undefined);
      throw err;
    }
  }
  await releaseLease(ctx);
  const after = await db.withTenant(session.tenantId, (q) => readRun(q, id));
  return after ? { ok: true, run: after } : { ok: false, category: "not_found" };
}

// The lease is handed back with the time of the last work, so the next slice starts at once.
async function releaseLease(ctx: Ctx): Promise<void> {
  await ctx.db.withTenant(ctx.tenantId, (q) =>
    q.execute(
      `UPDATE card_recon_runs SET lease_until = CAST($3 AS timestamptz), lease_token = NULL
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND lease_token = CAST($2 AS uuid)`,
      [ctx.runId, ctx.token, ctx.clock().toISOString()],
    ),
  );
}

// A step that threw ends the run (the page stops waiting); a new press starts a fresh one.
async function failRun(ctx: Ctx): Promise<void> {
  await ctx.db.withTenant(ctx.tenantId, (q) =>
    q.execute(
      `UPDATE card_recon_runs
          SET status = 'failed', fail_category = 'error', phase = 'done', todo = '[]',
              lease_token = NULL, lease_until = NULL, finished_at = CAST($3 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
          AND lease_token = CAST($2 AS uuid) AND status = 'running'`,
      [ctx.runId, ctx.token, ctx.clock().toISOString()],
    ),
  );
}

// Inside a tenant transaction: the run is still this worker's, locked until the commit.
async function holdLease(q: Queryable, ctx: Ctx): Promise<RunRow> {
  const rows = await q.query<{ id: string }>(
    `SELECT CAST(id AS text) AS id FROM card_recon_runs
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND lease_token = CAST($2 AS uuid) AND status = 'running'
      FOR UPDATE`,
    [ctx.runId, ctx.token],
  );
  if (rows.length !== 1) throw new LeaseLost();
  const run = await readRunRow(q, ctx.runId);
  if (!run) throw new LeaseLost();
  return run;
}

const leased = <T>(ctx: Ctx, fn: (q: Queryable, run: RunRow) => Promise<T>) =>
  ctx.db.withTenant(ctx.tenantId, async (q) => fn(q, await holdLease(q, ctx)));

const timeLeft = (ctx: Ctx, needMs: number) => ctx.deadlineAt - ctx.clock().getTime() > needMs;

async function writeRun(
  q: Queryable,
  ctx: Ctx,
  set: { todo: string[]; counts: Counts; unchecked: Line[]; phase?: string },
): Promise<void> {
  await q.execute(
    `UPDATE card_recon_runs
        SET todo = CAST($2 AS jsonb), counts = CAST($3 AS jsonb), unchecked = CAST($4 AS jsonb),
            phase = COALESCE($5, phase)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [ctx.runId, JSON.stringify(set.todo), JSON.stringify(set.counts), JSON.stringify(set.unchecked), set.phase ?? null],
  );
}

async function slice(ctx: Ctx): Promise<void> {
  const limits = flags.cardRecon.limits;
  for (;;) {
    // The switch is read again before every step: turned off, the run stops where it is.
    if (!flags.cardRecon.enabled) return;
    const run = await leased(ctx, async (_q, r) => r);
    if (run.phase === "read") {
      if (run.todo.length === 0) {
        await toExplain(ctx);
        continue;
      }
      if (!timeLeft(ctx, limits.readBackTimeoutMs + 2_000)) return;
      await readStep(ctx, run);
    } else if (run.phase === "explain") {
      if (run.todo.length === 0) {
        await toMatch(ctx);
        continue;
      }
      if (!timeLeft(ctx, EXPLAIN_TIMEOUT_MS + 3_000)) return;
      await explainStep(ctx, run);
    } else if (run.phase === "match") {
      if (run.todo.length === 0) return finish(ctx);
      if (!timeLeft(ctx, MATCH_TIMEOUT_MS + 3_000)) return;
      await matchStep(ctx, run);
    } else {
      return;
    }
  }
}

// ---- Read ----

async function readStep(ctx: Ctx, run: RunRow): Promise<void> {
  const limits = flags.cardRecon.limits;
  const batch = run.todo.slice(0, READ_BATCH);
  const counts = run.counts;
  const lines = [...run.unchecked];
  const { zone, actions } = await ctx.db.withTenant(ctx.tenantId, async (q) => {
    const list: MoneyAction[] = [];
    for (const id of batch) {
      const a = await readAction(q, id);
      if (a) list.push(a);
    }
    return { zone: await readTenantZone(q), actions: list };
  });
  counts.notChecked += batch.length - actions.length;

  // Which records are read now: confirmed, on a system that can be read, under its system's cap.
  const toRead: MoneyAction[] = [];
  for (const a of actions) {
    if (a.state !== "confirmed") continue;
    const key = systemKey(a.kind);
    const system = systemOf(a, ctx.money) ?? key;
    let ready = ctx.ready.get(key);
    if (!ready) {
      ready = await systemReady(ctx.db, ctx.tenantId, a.kind, ctx.money);
      ctx.ready.set(key, ready);
    }
    if (!ready.ok) {
      addLine(lines, { system, category: "not_connected" });
      counts.notConnected += 1;
      continue;
    }
    const n = counts.readBySystem[key] ?? 0;
    if (n >= limits.maxReadBacksPerSystem) {
      addLine(lines, { system, category: "over_limit" });
      counts.notChecked += 1;
      continue;
    }
    counts.readBySystem[key] = n + 1;
    toRead.push(a);
  }
  if (!ctx.hooks) ctx.hooks = readHooks(ctx.db, ctx.tenantId, ctx.money);
  const hooks = ctx.hooks;
  const settled = await Promise.allSettled(
    toRead.map((a) =>
      readOneBack(
        ctx.db,
        ctx.tenantId,
        a,
        hooks[a.kind],
        { requestId: a.requestId, timeoutMs: limits.readBackTimeoutMs, tenantZone: zone },
        ctx.money,
      ),
    ),
  );
  const outcomes = new Map<string, ReadOutcome>();
  toRead.forEach((a, i) => {
    const s = settled[i];
    outcomes.set(a.id, s.status === "fulfilled" ? s.value : { ok: false, category: "unknown" });
  });

  await leased(ctx, async (q) => {
    const nowIso = ctx.clock().toISOString();
    for (const a of actions) {
      const confirmed = a.state === "confirmed";
      if (confirmed && !outcomes.has(a.id)) continue; // not connected or over the cap: left as is
      const outcome = outcomes.get(a.id) ?? null;
      const cmp = compareReadBack(ledgerFact(a, ctx.money), confirmed ? outcome : null);
      if (outcome?.ok) counts.recordsRead += 1;
      if (cmp.kind === "break") {
        await upsertBreaks(q, [{ b: cmp.break, id: randomUUID() }], ctx.runId, nowIso);
        await resolveRecordBreaks(q, [{ id: a.id, keep: fingerprintOf(cmp.break) }], LEDGER_CATEGORIES, nowIso);
        counts.recordBreaks += 1;
      } else if (cmp.kind === "clean") {
        await resolveRecordBreaks(q, [{ id: a.id, keep: null }], LEDGER_CATEGORIES, nowIso);
        if (confirmed) counts.recordsClean += 1;
      } else {
        // Threw or timed out: unknown, so nothing it found earlier is closed.
        addLine(lines, { system: systemOf(a, ctx.money) ?? systemKey(a.kind), category: cmp.category });
        counts.notChecked += 1;
      }
    }
    await writeRun(q, ctx, { todo: run.todo.slice(batch.length), counts, unchecked: lines });
  });
}

// ---- Explain ----

async function toExplain(ctx: Ctx): Promise<void> {
  await leased(ctx, async (q, run) => {
    // New or changed open breaks this run saw, most severe first. A sentence the model already
    // failed once is not asked again until an amount moves; one skipped for the budget is.
    const rows = await q.query<{ id: string }>(
      `SELECT CAST(id AS text) AS id FROM card_recon_breaks
        WHERE tenant_id = current_tenant_id() AND status = 'open' AND last_seen_run_id = CAST($1 AS uuid)
          AND explanation IS NULL AND (explain_category IS NULL OR explain_category = 'budget')
        ORDER BY ${SEVERITY_ORDER}, id LIMIT ${flags.cardRecon.limits.maxBreaks}`,
      [ctx.runId],
    );
    await writeRun(q, ctx, { ...run, todo: rows.map((r) => r.id), phase: "explain" });
  });
}

// Counts cents against the run's cap before a call; false when they do not fit.
async function reserveCents(ctx: Ctx, q: Queryable, cents: number): Promise<boolean> {
  if (!Number.isSafeInteger(cents) || cents <= 0) return false;
  const rows = await q.query<{ id: string }>(
    `UPDATE card_recon_runs SET model_cents = model_cents + $2
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND model_cents + $2 <= $3
      RETURNING id`,
    [ctx.runId, cents, flags.cardRecon.limits.maxRunCents],
  );
  return rows.length === 1;
}

// Replaces a reservation with the real cost. No cost back (no answer): the reservation stays.
async function settleCents(ctx: Ctx, q: Queryable, reserved: number, costNanocents: number | null): Promise<void> {
  if (costNanocents === null) return;
  await q.execute(
    `UPDATE card_recon_runs SET model_cents = GREATEST(0, model_cents - $2 + $3)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [ctx.runId, reserved, centsOfNano(costNanocents)],
  );
}

async function explainStep(ctx: Ctx, run: RunRow): Promise<void> {
  const reserve = flags.cardRecon.limits.maxExplainCents;
  const breakId = run.todo[0];
  const rest = run.todo.slice(1);
  const b = await ctx.db.withTenant(ctx.tenantId, (q) => readBreak(q, breakId));
  if (!b || b.status !== "open" || b.explanation !== null) {
    await leased(ctx, (q, r) => writeRun(q, ctx, { ...r, todo: rest }));
    return;
  }
  const reserved = await leased(ctx, async (q, r) => {
    if (await reserveCents(ctx, q, reserve)) return true;
    // Past the cap: every break left shows its fixed sentence; a later check tries again.
    await q.execute(
      `UPDATE card_recon_breaks SET explain_category = 'budget'
        WHERE tenant_id = current_tenant_id() AND status = 'open' AND explanation IS NULL
          AND id IN (SELECT CAST(x AS uuid) FROM jsonb_array_elements_text(CAST($1 AS jsonb)) AS x)`,
      [JSON.stringify(r.todo)],
    );
    await writeRun(q, ctx, { ...r, todo: [] });
    return false;
  });
  if (!reserved) return;
  const explained = await explainBreak(
    ctx.session,
    {
      traceId: ctx.runId,
      category: b.category,
      record: recordWords(b),
      outsideSystem: b.outsideSystem,
      ourCents: b.ourCents,
      outsideCents: b.outsideCents,
      maxCostCents: reserve,
    },
    { complete: ctx.complete },
  );
  await leased(ctx, async (q, r) => {
    await settleCents(ctx, q, reserve, explained.costNanocents);
    await q.execute(
      `UPDATE card_recon_breaks SET explanation = $2, explain_category = $3
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'open'`,
      [b.id, explained.ok ? explained.text : null, explained.ok ? null : explained.category],
    );
    const counts = r.counts;
    if (explained.ok) counts.explained += 1;
    await writeRun(q, ctx, { ...r, counts, todo: r.todo.filter((x) => x !== breakId) });
  });
}

// ---- Match ----

async function toMatch(ctx: Ctx): Promise<void> {
  await leased(ctx, async (q, run) => {
    // Open unknown cards this run saw with no match card yet, or whose card expired or failed. A
    // card a person rejected is not put back: that break stays "By hand".
    const rows = await q.query<{ id: string }>(
      `SELECT CAST(b.id AS text) AS id FROM card_recon_breaks b
        WHERE b.tenant_id = current_tenant_id() AND b.status = 'open' AND b.category = 'card_unknown'
          AND b.last_seen_run_id = CAST($1 AS uuid)
          AND (b.proposal_id IS NULL OR EXISTS (
                SELECT 1 FROM proposals p WHERE p.tenant_id = b.tenant_id AND p.id = b.proposal_id
                   AND p.status IN ('expired', 'failed')))
        ORDER BY b.id LIMIT ${flags.cardRecon.limits.maxBreaks}`,
      [ctx.runId],
    );
    await writeRun(q, ctx, { ...run, todo: rows.map((r) => r.id), phase: "match" });
  });
}

async function matchStep(ctx: Ctx, run: RunRow): Promise<void> {
  const limits = flags.cardRecon.limits;
  const breakId = run.todo[0];
  const pop = (r: RunRow) => r.todo.filter((x) => x !== breakId);
  const facts = await ctx.db.withTenant(ctx.tenantId, async (q) => {
    const b = await readBreak(q, breakId);
    if (!b || b.status !== "open" || b.category !== "card_unknown" || !b.transaction) return null;
    const m = await readMatchFacts(q, b.transaction.id);
    // Its card or its purchase reached our records since: no longer unknown.
    if (!m || m.kind !== "fuel" || m.cardOnFile || m.purchaseOnFile) return null;
    const ranked = rankCandidates(
      { postedOn: m.txn.postedOn, state: m.txn.state, portalName: m.txn.portalName },
      await readCandidateFacts(q, m.txn.postedOn),
    );
    return { m, ranked };
  });
  if (!facts) {
    await leased(ctx, (q, r) => writeRun(q, ctx, { ...r, todo: pop(r) }));
    return;
  }
  const { m, ranked } = facts;
  // No call without a clear top candidate: a person picks.
  const callable = ranked.length > 0 && !topIsTied(ranked);
  const reserved = callable ? await leased(ctx, (q) => reserveCents(ctx, q, limits.matchMaxCents)) : false;
  let picked: Picked;
  if (!callable) picked = { ok: false, category: ranked.length === 0 ? "no_candidates" : "tied", callId: null, costNanocents: null };
  else if (!reserved) picked = { ok: false, category: "budget", callId: null, costNanocents: null };
  else {
    picked = await pickDriver(
      ctx.session,
      { traceId: ctx.runId, txn: m.txn, candidates: ranked, maxCostCents: limits.matchMaxCents },
      { complete: ctx.complete },
    );
  }
  await leased(ctx, async (q, r) => {
    if (reserved) await settleCents(ctx, q, limits.matchMaxCents, picked.costNanocents);
    const counts = r.counts;
    const persisted = picked.ok
      ? await persistMatch(q, ctx.session, ctx.clock(), { txn: m.txn, candidates: ranked, driverId: picked.driverId })
      : null;
    if (persisted) {
      // A card a person already decided stays decided: the break is theirs by hand.
      const fix = persisted.kind === "already_decided" ? "by_hand" : "card_match";
      if (persisted.kind === "created") counts.matchCards += 1;
      await q.execute(
        `UPDATE card_recon_breaks SET proposal_id = CAST($2 AS uuid), fix_kind = $3
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'open'`,
        [breakId, persisted.proposalId, fix],
      );
    } else {
      await q.execute(
        `UPDATE card_recon_breaks SET fix_kind = 'by_hand'
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'open'
            AND proposal_id IS NULL`,
        [breakId],
      );
    }
    await writeRun(q, ctx, { ...r, counts, todo: pop(r) });
  });
}

// ---- Done ----

async function finish(ctx: Ctx): Promise<void> {
  await leased(ctx, async (q, run) => {
    // A waiting match card whose card is no longer an open unknown card is retired.
    const keep = await q.query<{ id: string }>(
      `SELECT DISTINCT CAST(card_transaction_id AS text) AS id FROM card_recon_breaks
        WHERE tenant_id = current_tenant_id() AND status = 'open' AND category = 'card_unknown'
          AND card_transaction_id IS NOT NULL`,
    );
    await retireEngineProposalsExcept(q, "card_match", new Set(keep.map((r) => r.id)), ctx.session, ctx.clock());
    const open = await countOpenBreaks(q);
    // The statement's differences when the check ends, for the verdict: the open ones by category,
    // and how many a person dismissed.
    const byCategory = await q.query<{ category: string; status: string; n: number | string }>(
      `SELECT b.category, b.status, count(*) AS n
         FROM card_recon_breaks b
         JOIN card_recon_runs r ON r.tenant_id = b.tenant_id AND r.id = CAST($1 AS uuid)
         JOIN card_transactions t ON t.tenant_id = b.tenant_id AND t.id = b.card_transaction_id
        WHERE b.tenant_id = current_tenant_id() AND b.status IN ('open', 'dismissed')
          AND b.category IN (${sqlList(STATEMENT_CATEGORIES)})
          AND t.posted_on BETWEEN r.window_from AND r.window_to
        GROUP BY b.category, b.status`,
      [ctx.runId],
    );
    const statementOpen: Partial<Record<BreakCategory, number>> = {};
    let statementClosed = 0;
    for (const row of byCategory) {
      const n = Number(row.n);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("not a whole count");
      if (row.status === "open") statementOpen[row.category as BreakCategory] = n;
      else statementClosed += n;
    }
    const counts = {
      ...run.counts,
      needsYou: open.needsYou,
      notConfirmed: open.notConfirmed,
      statementOpen,
      statementClosed,
    };
    await q.execute(
      `UPDATE card_recon_runs
          SET status = 'done', phase = 'done', todo = '[]', counts = CAST($2 AS jsonb),
              lease_token = NULL, lease_until = NULL, finished_at = CAST($3 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [ctx.runId, JSON.stringify(counts), ctx.clock().toISOString()],
    );
  });
}

// ---- Verdict ----

// Whether the card statement can be paid, from a finished check's stored counts, by code alone:
// verified (every line compared and none open: pay the statement's total, in cents, with how many
// differences a person dismissed), hold (a difference is open, or not every line was compared), or
// empty (no line in the window). Null when
// the check is not done or its counts do not say (unknown is not zero). Nothing here pays: a
// person pays the statement outside the app.
export type StatementVerdict =
  | { kind: "verified"; cents: number; lines: number; closed: number }
  | { kind: "hold"; breaks: number; byCategory: { category: BreakCategory; count: number }[]; cut: boolean }
  | { kind: "empty" };

const CUT_LINES = ["too_many_rows", "too_many_differences"];

export function statementVerdict(run: Pick<RunView, "status" | "counts" | "unchecked">): StatementVerdict | null {
  if (run.status !== "done") return null;
  const lines = run.counts.statement;
  const cents = run.counts.statementCents;
  if (typeof lines !== "number" || !Number.isSafeInteger(lines) || lines < 0) return null;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0) return null;
  const closed = run.counts.statementClosed;
  if (typeof closed !== "number" || !Number.isSafeInteger(closed) || closed < 0) return null;
  const open = statementOpenOf(run.counts.statementOpen);
  if (!open) return null;
  const byCategory = STATEMENT_CATEGORIES.filter((c) => (open[c] ?? 0) > 0).map((c) => ({
    category: c,
    count: open[c] ?? 0,
  }));
  const breaks = byCategory.reduce((sum, b) => sum + b.count, 0);
  const cut = run.unchecked.some(
    (l) =>
      !!l &&
      typeof l === "object" &&
      (l as Record<string, unknown>).system === "fuel_card_sim" &&
      CUT_LINES.includes(String((l as Record<string, unknown>).category)),
  );
  if (breaks > 0 || cut) return { kind: "hold", breaks, byCategory, cut };
  if (lines === 0) return cents === 0 ? { kind: "empty" } : null;
  // Every statement row is more than zero cents.
  if (cents < lines) return null;
  return { kind: "verified", cents, lines, closed };
}

// ---- Dismiss ----

// A person closes a break with a reason. Only an open one; a later check never reopens it.
export async function dismissBreak(
  session: Session,
  breakId: string,
  category: string,
  deps: Pick<CardCheckDeps, "db" | "clock"> = {},
): Promise<DismissResult> {
  if (!flags.cardRecon.enabled) return { ok: false, category: "disabled" };
  if (!isUuid(breakId) || !(DISMISS_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, category: "bad_request" };
  }
  const db = deps.db ?? getDb();
  const nowIso = (deps.clock ?? (() => new Date()))().toISOString();
  const n = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return q.execute(
      `UPDATE card_recon_breaks
          SET status = 'dismissed', dismiss_category = $2, resolved_at = CAST($3 AS timestamptz),
              updated_at = CAST($3 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'open'`,
      [breakId.toLowerCase(), category, nowIso],
    );
  });
  return n === 1 ? { ok: true } : { ok: false, category: "not_found" };
}
