import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, complete, type AiErrorCategory, type AiFormat, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { readReceivablesInput, readTable, readTenant } from "../data/read";
import { getDb, type Queryable, type TenantDb } from "../db";
import { tenantLock } from "../invoices/number";
import { planCollections, type ChaseCandidate } from "../rules-engine/collections";
import { assertMembership } from "../tenant/context";
import { carrierToday } from "../tenant/shell";
import { buildReminderPack, figuresOf, packText, type ReminderPack } from "./pack";
import { MAX_SUBJECT_CHARS, verifyReminder } from "./verify";
import { DRAFTING_LEASE_MS } from "./view";

export { DRAFTING_LEASE_MS };

// Drafts payment reminders for invoices at least minDaysLate past due. The only file in
// src/lib/collections that reaches a model, and only through complete() in src/lib/ai, which
// checks aiEnabled, reserves the worst case in the spend ledger and enforces the global cap.
//
// Code picks everything but the words: which invoices (the rules engine's planCollections, from
// the money actually applied), the stage (30, 60 or 90 days) and the tone (from the stage and how
// the customer has paid). The model writes a subject and a body from the pack (pack.ts) and the
// check (verify.ts) runs before a person sees it. A draft is only a draft: nothing is sent here.
//
// Each reminder is reserved first: its row is written (drafting) before the model call, under
// UNIQUE (tenant_id, invoice_id, stage), so a second click, a second tab or a retry never drafts
// the same invoice and stage twice. A row left drafting by a crash, a deploy or an error that is
// not the model's goes back to waiting (over_cap) once its lease runs out, and the run that finds
// it drafts it again under the same caps; it is never shown as approvable meanwhile. Only the run
// that reserved a reminder (its trace id) may finish it or give it back, so a run cut off late
// never writes over the run that picked its reminder up again.
//
// A reminder still waiting at a stage its invoice has since passed (waiting at 30, the invoice now
// 60 days late) is closed as refused (stage_passed) when a run plans, so it shows as not kept
// instead of waiting unseen; the invoice's new stage gets its own reminder.
//
// A call complete() turned down before any request went out (AI switched off, not configured,
// over the reminder's own limit, or over the spend cap) never reached a model, so the reminder goes
// back to waiting (over_cap, which the next run picks up), never refused. A refusal after a real
// request, a timeout and an unknown outcome are final: the reminder becomes refused with the
// category and keeps no text.
//
// One run is one press of the button: one trace id, at most maxDraftsPerRun reminders. Before each
// call the run's spend is read back from the model ledger by its trace id (settled cost, or the
// reservation while unsettled) under the carrier's collections lock. Calls in a run go one at a
// time and each is reserved before it is sent, so nothing is in flight while the cap is checked.
// If one more reminder could pass maxRunCents, the rest of the run is marked over_cap with no call.

export const REMINDER_PURPOSE = "collections_draft";
// A call's own limit; a reminder starts only if its call can finish before the request ends.
export const REMINDER_TIMEOUT_MS = 12_000;
const NANOCENTS_PER_CENT = 1_000_000_000;

export const REMINDER_FORMAT: AiFormat = {
  name: "payment_reminder",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["subject", "body"],
    properties: {
      subject: { type: "string" },
      body: { type: "string" },
    },
  },
};

export const REMINDER_RULES = [
  "You write a short payment reminder email from a trucking carrier to a customer about one past-due",
  "invoice, from the facts below. A person at the carrier reads it and approves it before it is sent.",
  "Rules:",
  "- Use the tone given. Friendly is a polite nudge, direct is clear and businesslike, firm is serious",
  "  and plain. Every tone stays courteous.",
  "- The subject is one line and includes the invoice number exactly as given.",
  "- The first dollar amount in the email must be the balance due. Copy every dollar amount exactly",
  "  from the facts, written like $1,234.56.",
  "- Write the due date as given and every number in digits. Use only numbers from the facts.",
  "- Ask the customer to pay the balance or to reply with a payment date.",
  "- Never mention interest, fees, penalties, legal action, lawyers, courts or collection agencies,",
  "  never say immediately, never set a deadline, and never threaten. No links, no promises and no",
  "  discounts.",
  "- Sign off with the carrier's name. Under 120 words in the body.",
  'Reply with JSON only: {"subject": the subject line, "body": the email body}.',
].join("\n");

export type CompleteFn = (target: "spark", request: AiRequest, session: Session) => Promise<AiResult>;

export type DraftDeps = {
  db?: TenantDb;
  complete?: CompleteFn;
  clock?: () => Date;
  newId?: () => string;
  log?: (line: string) => void;
};

export type DraftStop = "deadline" | "cap" | "model" | null;

export type DraftSummary =
  | { ok: false; category: "disabled" | "ai_disabled" }
  | {
      ok: true;
      // What this run did: reminders that passed the check, failed it, or wait for the next run.
      drafted: number;
      refused: number;
      overCap: number;
      // Late invoices that already have a reminder at their stage, and waiting reminders closed
      // because their invoice reached a later stage.
      skipped: number;
      // Late invoices this run did not reach (over maxDraftsPerRun, or stopped early).
      remaining: number;
      stoppedBy: DraftStop;
      // True when late invoices are still waiting for a reminder: press the button again.
      more: boolean;
      traceId: string;
    };

// complete() throws these before any provider request (src/lib/ai/index.ts and spend.ts reserve,
// which writes no ledger row for cap or job_cap). Every other category follows a request that
// was sent.
const BEFORE_ANY_REQUEST: ReadonlySet<AiErrorCategory> = new Set<AiErrorCategory>([
  "disabled",
  "not_configured",
  "too_expensive",
  "cap",
  "job_cap",
]);

export function reminderRequest(pack: ReminderPack, traceId: string): AiRequest {
  return {
    purpose: REMINDER_PURPOSE,
    // Reasoning tokens count against the reminder's small output budget, so as little as possible.
    reasoningEffort: "minimal",
    maxOutputTokens: flags.collectionsLimits.maxOutputTokens,
    maxCostCents: flags.collectionsLimits.maxDraftCents,
    timeoutMs: REMINDER_TIMEOUT_MS,
    traceId,
    format: REMINDER_FORMAT,
    messages: [
      { role: "system", content: REMINDER_RULES },
      {
        role: "user",
        content: [`The subject must be at most ${MAX_SUBJECT_CHARS} characters.`, "", packText(pack)].join("\n"),
      },
    ],
  };
}

// One late invoice this run will draft: a new reminder, or one waiting from an earlier run.
type WorkItem = { candidate: ChaseCandidate; rowId: string | null; customerName: string };

type Plan = { carrierName: string; asOf: string; work: WorkItem[]; skipped: number; remaining: number };

type ExistingRow = { id: string; invoice_id: string; stage: string; status: string };

async function readPlan(q: Queryable, now: Date, nowIso: string): Promise<Plan> {
  // A reminder left drafting past its lease was cut off. With no model call named it goes back to
  // waiting and this run drafts it again; one naming a call would stay refused (interrupted). 0041
  // keeps a drafting row's call id null (the id is written only on the step out of drafting), so
  // today every stale reminder waits again.
  await q.execute(
    `UPDATE collection_drafts
        SET status = CASE WHEN model_call_id IS NULL THEN 'over_cap' ELSE 'refused' END,
            refusal_category = CASE WHEN model_call_id IS NULL THEN NULL ELSE 'interrupted' END,
            updated_at = CAST($1 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND status = 'drafting' AND updated_at < CAST($2 AS timestamptz)`,
    [nowIso, new Date(now.getTime() - DRAFTING_LEASE_MS).toISOString()],
  );
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant row");
  const asOf = carrierToday(tenant.timezone, now);
  const input = await readReceivablesInput(q, asOf);
  const names = new Map((await readTable(q, "customers")).map((c) => [c.id, c.name]));
  const existing = await q.query<ExistingRow>(
    `SELECT CAST(id AS text) AS id, CAST(invoice_id AS text) AS invoice_id, stage, status
       FROM collection_drafts WHERE tenant_id = current_tenant_id()`,
  );
  const byKey = new Map(existing.map((r) => [`${r.invoice_id}:${r.stage}`, r]));
  const candidates = planCollections(input, null, flags.collectionsLimits.minDaysLate);

  // A waiting reminder at a stage its invoice has passed is never drafted: it is closed, and counted
  // with the skipped, so it shows on the page as not kept rather than waiting unseen.
  let skipped = 0;
  const stageNow = new Map(candidates.map((c) => [c.invoiceId, Number(c.stage)]));
  for (const row of existing) {
    const current = stageNow.get(row.invoice_id);
    if (row.status !== "over_cap" || current === undefined || Number(row.stage) >= current) continue;
    skipped += await q.execute(
      `UPDATE collection_drafts SET status = 'refused', refusal_category = 'stage_passed',
              updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'over_cap'`,
      [row.id, nowIso],
    );
  }

  const work: WorkItem[] = [];
  for (const candidate of candidates) {
    const row = byKey.get(`${candidate.invoiceId}:${candidate.stage}`);
    const customerName = names.get(candidate.customerId);
    if (customerName === undefined) throw new Error("an invoice names a missing customer");
    if (!row) work.push({ candidate, rowId: null, customerName });
    else if (row.status === "over_cap") work.push({ candidate, rowId: row.id, customerName });
    else skipped += 1;
  }
  const limit = flags.collectionsLimits.maxDraftsPerRun;
  return {
    carrierName: tenant.name,
    asOf,
    work: work.slice(0, limit),
    skipped,
    remaining: Math.max(0, work.length - limit),
  };
}

// The run's spend in nanocents: what the ledger holds for every call made under its trace id.
async function readRunSpend(q: Queryable, traceId: string): Promise<number> {
  const [row] = await q.query<{ spent: number | string }>(
    `SELECT CAST(COALESCE(sum(COALESCE(cost_nanocents, reserved_nanocents)), 0) AS bigint) AS spent
       FROM model_calls
      WHERE tenant_id = current_tenant_id() AND purpose = $1 AND trace_id = CAST($2 AS uuid)`,
    [REMINDER_PURPOSE, traceId],
  );
  const spent = Number(row?.spent);
  // Unknown is not zero: a read that does not come back as a number stops the run.
  return Number.isSafeInteger(spent) ? spent : Number.MAX_SAFE_INTEGER;
}

const INSERT_RESERVATION = `INSERT INTO collection_drafts (id, tenant_id, invoice_id, customer_id, stage, tone, status,
     figures, trace_id, created_at, updated_at)
   SELECT CAST($1 AS uuid), current_tenant_id(), i.id, i.customer_id, $3, $4, $5, CAST($6 AS jsonb),
          CAST($7 AS uuid), CAST($8 AS timestamptz), CAST($8 AS timestamptz)
     FROM invoices i
    WHERE i.tenant_id = current_tenant_id() AND i.id = CAST($2 AS uuid)
   ON CONFLICT (tenant_id, invoice_id, stage) DO NOTHING`;

function reservationParams(id: string, item: WorkItem, status: string, asOf: string, traceId: string, now: string) {
  const c = item.candidate;
  return [id, c.invoiceId, c.stage, c.tone, status, JSON.stringify(figuresOf(c, asOf)), traceId, now];
}

// Writes over_cap for every item with no reminder yet. A reminder already over_cap stays as it is.
// Returns how many of the items now wait for the next run.
async function markOverCap(q: Queryable, items: WorkItem[], asOf: string, traceId: string, newId: () => string, now: string) {
  let n = 0;
  for (const item of items) {
    if (item.rowId !== null) n += 1;
    else n += await q.execute(INSERT_RESERVATION, reservationParams(newId(), item, "over_cap", asOf, traceId, now));
  }
  return n;
}

type Claim = { id: string; pack: ReminderPack } | { cap: number } | null;

// One transaction: take the carrier's collections lock, check the run cap, reserve the reminder.
async function claim(
  q: Queryable,
  plan: Plan,
  index: number,
  traceId: string,
  newId: () => string,
  now: string,
): Promise<Claim> {
  await tenantLock(q, "collections_draft");
  const limits = flags.collectionsLimits;
  const spent = await readRunSpend(q, traceId);
  if (spent + limits.maxDraftCents * NANOCENTS_PER_CENT > limits.maxRunCents * NANOCENTS_PER_CENT) {
    return { cap: await markOverCap(q, plan.work.slice(index), plan.asOf, traceId, newId, now) };
  }
  const item = plan.work[index];
  const c = item.candidate;
  let id: string;
  if (item.rowId === null) {
    id = newId();
    const n = await q.execute(INSERT_RESERVATION, reservationParams(id, item, "drafting", plan.asOf, traceId, now));
    if (n !== 1) return null;
  } else {
    id = item.rowId;
    // A waiting reminder is written from today's figures and tone, under this run.
    const n = await q.execute(
      `UPDATE collection_drafts
          SET status = 'drafting', tone = $2, figures = CAST($3 AS jsonb), trace_id = CAST($4 AS uuid),
              updated_at = CAST($5 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'over_cap'
          AND invoice_id = CAST($6 AS uuid) AND stage = $7`,
      [id, c.tone, JSON.stringify(figuresOf(c, plan.asOf)), traceId, now, c.invoiceId, c.stage],
    );
    if (n !== 1) return null;
  }
  return { id, pack: buildReminderPack(figuresOf(c, plan.asOf), c.tone, item.customerName, plan.carrierName) };
}

type Finish =
  | { status: "drafted"; subject: string; body: string; verification: object; modelCallId: string }
  | { status: "refused"; category: string; verification: object | null; modelCallId: string | null };

async function finish(
  db: TenantDb,
  session: Session,
  id: string,
  traceId: string,
  f: Finish,
  now: string,
): Promise<boolean> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const n = await q.execute(
      `UPDATE collection_drafts
          SET status = $2, subject = $3, body = $4, verification = CAST($5 AS jsonb), refusal_category = $6,
              model_call_id = CAST($7 AS uuid), updated_at = CAST($8 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'drafting'
          AND trace_id = CAST($9 AS uuid)`,
      [
        id,
        f.status,
        f.status === "drafted" ? f.subject : null,
        f.status === "drafted" ? f.body : null,
        f.verification === null ? null : JSON.stringify(f.verification),
        f.status === "refused" ? f.category : null,
        f.modelCallId,
        now,
        traceId,
      ],
    );
    return n === 1;
  });
}

// A reminder whose call never went out goes back to waiting for the next run. Only a reminder still
// drafting under this run that names no model call moves.
async function giveBack(db: TenantDb, session: Session, id: string, traceId: string, now: string): Promise<boolean> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const n = await q.execute(
      `UPDATE collection_drafts SET status = 'over_cap', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'drafting'
          AND model_call_id IS NULL AND trace_id = CAST($3 AS uuid)`,
      [id, now, traceId],
    );
    return n === 1;
  });
}

export async function draftCollections(session: Session, deadlineAt: Date, deps: DraftDeps = {}): Promise<DraftSummary> {
  // Each switch is re-checked here, whoever calls; complete() checks aiEnabled again.
  if (!flags.collectionsEnabled) return { ok: false, category: "disabled" };
  if (!flags.aiEnabled) return { ok: false, category: "ai_disabled" };
  const db = deps.db ?? getDb();
  const call = deps.complete ?? ((target, request, s) => complete(target, request, s));
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? ((line: string) => console.log(line));
  const iso = () => clock().toISOString();
  const traceId = newId();

  const plan = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    await tenantLock(q, "collections_draft");
    const now = clock();
    return readPlan(q, now, now.toISOString());
  });

  let drafted = 0;
  let refused = 0;
  let overCap = 0;
  let reached = 0;
  let stoppedBy: DraftStop = null;
  for (let i = 0; i < plan.work.length; i++) {
    if (clock().getTime() + REMINDER_TIMEOUT_MS > deadlineAt.getTime()) {
      stoppedBy = "deadline";
      break;
    }
    const claimed = await db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      return claim(q, plan, i, traceId, newId, iso());
    });
    if (claimed !== null && "cap" in claimed) {
      overCap += claimed.cap;
      reached = plan.work.length;
      stoppedBy = "cap";
      break;
    }
    reached = i + 1;
    if (claimed === null) continue;

    let result: AiResult;
    try {
      result = await call("spark", reminderRequest(claimed.pack, traceId), session);
    } catch (err) {
      // Any other error leaves the reminder drafting, an outcome not known: the next run's lease
      // puts it back to waiting once any call it made has ended, and the page lists it as waiting.
      if (!(err instanceof AiError)) throw err;
      if (BEFORE_ANY_REQUEST.has(err.category)) {
        // No request went out: the reminder waits for the next run with the rest.
        if (await giveBack(db, session, claimed.id, traceId, iso())) overCap += 1;
      } else {
        // The category only; the row keeps no text. The rest wait for the next run.
        const done = await finish(
          db,
          session,
          claimed.id,
          traceId,
          { status: "refused", category: err.category, verification: null, modelCallId: null },
          iso(),
        );
        if (done) refused += 1;
      }
      stoppedBy = "model";
      break;
    }
    let f: Finish;
    if (result.status !== "ok") {
      // Cut off by the output budget: nothing was checked, so no check record is stored.
      f = { status: "refused", category: "incomplete", verification: null, modelCallId: result.callId };
    } else {
      const checked = verifyReminder(result.text, claimed.pack);
      f = checked.ok
        ? {
            status: "drafted",
            subject: checked.subject,
            body: checked.body,
            verification: checked.verification,
            modelCallId: result.callId,
          }
        : { status: "refused", category: checked.category, verification: checked.verification, modelCallId: result.callId };
    }
    if (await finish(db, session, claimed.id, traceId, f, iso())) {
      if (f.status === "drafted") drafted += 1;
      else refused += 1;
    }
  }

  const remaining = plan.remaining + (plan.work.length - reached);
  log(`collections: drafted ${drafted}, refused ${refused}, over_cap ${overCap} (run ${traceId})`);
  return {
    ok: true,
    drafted,
    refused,
    overCap,
    skipped: plan.skipped,
    remaining,
    stoppedBy,
    more: remaining > 0 || overCap > 0,
    traceId,
  };
}
