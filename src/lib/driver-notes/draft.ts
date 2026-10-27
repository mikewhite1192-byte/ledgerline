import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, complete, type AiErrorCategory, type AiFormat, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { buildPack, packText, readNoteSource, type NotePack } from "./pack";
import { MAX_BODY_CHARS, MODEL_LANGUAGE, verifyNote } from "./verify";

// Drafts one note per settled settlement of a period that has none yet. The only file in
// src/lib/driver-notes that reaches a model, and only through complete() in src/lib/ai, which
// checks aiEnabled, reserves the worst case in the spend ledger and enforces the global cap.
//
// Each note is reserved first: its row is written (drafting) before the model call, under
// UNIQUE (tenant_id, settlement_id), so a second click, a second tab or a retry never drafts a
// settlement twice. The call's answer is checked (verify.ts) before the row moves to drafted; a
// note that fails becomes refused with its category and no text. A row left drafting by a crash
// is marked refused (interrupted) once its lease runs out, so it is never shown as approvable.
//
// A call complete() turned down before any request went out (AI switched off, not configured,
// over the note's own limit, or over the spend cap) never reached a model, so the note goes back
// to waiting (over_cap, which the next pass picks up), never refused. That step is allowed only
// while the note names no model call. A refusal after a real request, a timeout and an unknown
// outcome are final: the note becomes refused with the category.
//
// The period's cap: before each call the period's note spend is read back from the model ledger
// (settled cost, or the reservation while unsettled) plus the worst case of every note still
// drafting. If one more note could pass the cap, the remaining notes become over_cap with no call.
// The period row is locked while this is decided, so two requests cannot both pass the cap.

export const NOTE_PURPOSE = "driver_note";
// A call's own limit; a note starts only if its call can finish before the slice ends.
export const NOTE_TIMEOUT_MS = 12_000;
// A row left drafting longer than this was cut off mid-call (the route runs at most 30 s).
export const DRAFTING_LEASE_MS = 60_000;
const NANOCENTS_PER_CENT = 1_000_000_000;

export const NOTE_FORMAT: AiFormat = {
  name: "driver_note",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["language", "body", "cited_seqs"],
    properties: {
      language: { type: "string", enum: ["English", "Spanish"] },
      body: { type: "string" },
      cited_seqs: { type: "array", items: { type: "integer" } },
    },
  },
};

export const NOTE_RULES = [
  "You write a short note to a truck driver that explains their pay for one period, from the",
  "paystub below. The note is read by the driver after a person at the carrier approves it.",
  "Rules:",
  "- Write in the language given. Use plain, warm, respectful words. Under 90 words.",
  "- Greet the driver by first name. Say the net pay first, then what made it up: the first",
  "  dollar amount in the note must be the net pay.",
  "- Every dollar amount must be copied exactly from the paystub, written like $1,234.56.",
  "- Write every number in digits. Use only numbers that appear on the paystub.",
  "- When you mention a line, cite it as [line n] with its line number, and list every line",
  "  you cite in cited_seqs.",
  "- Explain only what is on the paystub. No advice about money, taxes or debts, no promises",
  "  about future pay, no links, and no questions back to the driver.",
  "- If a deduction or a shortfall is on the paystub, say what it is in plain words.",
  'Reply with JSON only: {"language": "English" or "Spanish", "body": the note, "cited_seqs": [line numbers]}.',
].join("\n");

export type CompleteFn = (target: "spark", request: AiRequest, session: Session) => Promise<AiResult>;

export type DraftDeps = {
  db?: TenantDb;
  complete?: CompleteFn;
  clock?: () => Date;
  newId?: () => string;
};

export type DraftStop = "deadline" | "cap" | "model" | null;

export type DraftSummary =
  | { ok: false; category: "disabled" | "ai_disabled" | "not_found" }
  | {
      ok: true;
      // Settled settlements in the period, and how many of them have a note in each state.
      total: number;
      drafted: number;
      refused: number;
      overCap: number;
      drafting: number;
      missing: number;
      // Notes this request wrote.
      written: number;
      stoppedBy: DraftStop;
      // True when the slice ran out with notes still to draft: call again.
      more: boolean;
    };

type Candidate = { settlement_id: string; note_id: string | null; status: string | null };

// complete() throws these before any provider request (src/lib/ai/index.ts and spend.ts reserve,
// which writes nothing for cap). Every other category follows a request that was sent.
const BEFORE_ANY_REQUEST: ReadonlySet<AiErrorCategory> = new Set<AiErrorCategory>([
  "disabled",
  "not_configured",
  "too_expensive",
  "cap",
]);

export function noteRequest(pack: NotePack, traceId: string): AiRequest {
  return {
    purpose: NOTE_PURPOSE,
    // Reasoning tokens count against the note's small output budget, so as little as possible.
    reasoningEffort: "minimal",
    maxOutputTokens: flags.driverNoteLimits.maxOutputTokens,
    maxCostCents: flags.driverNoteLimits.maxNoteCents,
    timeoutMs: NOTE_TIMEOUT_MS,
    traceId,
    format: NOTE_FORMAT,
    messages: [
      { role: "system", content: NOTE_RULES },
      {
        role: "user",
        content: [
          `Language: ${MODEL_LANGUAGE[pack.language]}`,
          `The note must be at most ${MAX_BODY_CHARS} characters.`,
          "",
          packText(pack),
        ].join("\n"),
      },
    ],
  };
}

// Settled settlements of the period with no note yet, or whose note waits on the cap.
async function readCandidates(q: Queryable, periodId: string): Promise<Candidate[]> {
  return q.query<Candidate>(
    `SELECT CAST(s.id AS text) AS settlement_id, CAST(n.id AS text) AS note_id, n.status
       FROM settlements s
       JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
       LEFT JOIN driver_notes n ON n.tenant_id = s.tenant_id AND n.settlement_id = s.id
      WHERE s.tenant_id = current_tenant_id() AND d.tenant_id = current_tenant_id()
        AND s.period_id = CAST($1 AS uuid) AND s.status IN ('approved', 'paid')
        AND (n.id IS NULL OR n.status = 'over_cap')
      ORDER BY d.code`,
    [periodId],
  );
}

// The period's note spend in nanocents: what the ledger holds for every note past drafting, plus
// the worst case of each note still drafting (its call may not be reserved yet).
async function readPeriodSpend(q: Queryable, periodId: string): Promise<number> {
  const [row] = await q.query<{ spent: number | string; in_flight: number | string }>(
    `SELECT CAST(COALESCE((
              SELECT sum(COALESCE(m.cost_nanocents, m.reserved_nanocents))
                FROM model_calls m
               WHERE m.tenant_id = current_tenant_id() AND m.purpose = $2
                 AND m.trace_id IN (
                   SELECT n.trace_id FROM driver_notes n
                    WHERE n.tenant_id = current_tenant_id() AND n.period_id = CAST($1 AS uuid)
                      AND n.status <> 'drafting')), 0) AS bigint) AS spent,
            (SELECT count(*) FROM driver_notes n
              WHERE n.tenant_id = current_tenant_id() AND n.period_id = CAST($1 AS uuid)
                AND n.status = 'drafting') AS in_flight`,
    [periodId, NOTE_PURPOSE],
  );
  const spent = Number(row?.spent);
  const inFlight = Number(row?.in_flight);
  // Unknown is not zero: a read that does not come back as numbers stops drafting.
  if (!Number.isSafeInteger(spent) || !Number.isSafeInteger(inFlight)) return Number.MAX_SAFE_INTEGER;
  return spent + inFlight * flags.driverNoteLimits.maxNoteCents * NANOCENTS_PER_CENT;
}

// Writes over_cap for every candidate with no note yet. A note already over_cap stays as it is.
async function markOverCap(q: Queryable, periodId: string, settlementIds: string[], newId: () => string, now: string) {
  for (const settlementId of settlementIds) {
    await q.execute(
      `INSERT INTO driver_notes (id, tenant_id, settlement_id, driver_id, period_id, language, status,
         trace_id, created_at, updated_at)
       SELECT CAST($1 AS uuid), current_tenant_id(), s.id, s.driver_id, s.period_id, d.preferred_language,
              'over_cap', CAST($2 AS uuid), CAST($5 AS timestamptz), CAST($5 AS timestamptz)
         FROM settlements s
         JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
        WHERE s.tenant_id = current_tenant_id() AND d.tenant_id = current_tenant_id()
          AND s.id = CAST($3 AS uuid) AND s.period_id = CAST($4 AS uuid)
          AND s.status IN ('approved', 'paid')
       ON CONFLICT (tenant_id, settlement_id) DO NOTHING`,
      [newId(), newId(), settlementId, periodId, now],
    );
  }
}

type Claim = { noteId: string; traceId: string; pack: NotePack } | "cap" | null;

// One transaction: lock the period, check the cap, reserve the note, read its pack.
async function claimNote(
  q: Queryable,
  periodId: string,
  candidate: Candidate,
  remaining: Candidate[],
  newId: () => string,
  now: string,
): Promise<Claim> {
  const locked = await q.query<{ id: string }>(
    `SELECT CAST(id AS text) AS id FROM settlement_periods
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [periodId],
  );
  if (locked.length !== 1) return null;
  const spent = await readPeriodSpend(q, periodId);
  const limits = flags.driverNoteLimits;
  if (spent + limits.maxNoteCents * NANOCENTS_PER_CENT > limits.maxBatchCents * NANOCENTS_PER_CENT) {
    await markOverCap(
      q,
      periodId,
      remaining.filter((c) => c.note_id === null).map((c) => c.settlement_id),
      newId,
      now,
    );
    return "cap";
  }

  let noteId: string;
  if (candidate.note_id === null) {
    noteId = newId();
    const n = await q.execute(
      `INSERT INTO driver_notes (id, tenant_id, settlement_id, driver_id, period_id, language, status,
         trace_id, created_at, updated_at)
       SELECT CAST($1 AS uuid), current_tenant_id(), s.id, s.driver_id, s.period_id, d.preferred_language,
              'drafting', CAST($2 AS uuid), CAST($5 AS timestamptz), CAST($5 AS timestamptz)
         FROM settlements s
         JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
        WHERE s.tenant_id = current_tenant_id() AND d.tenant_id = current_tenant_id()
          AND s.id = CAST($3 AS uuid) AND s.period_id = CAST($4 AS uuid)
          AND s.status IN ('approved', 'paid')
       ON CONFLICT (tenant_id, settlement_id) DO NOTHING`,
      [noteId, newId(), candidate.settlement_id, periodId, now],
    );
    if (n !== 1) return null;
  } else {
    noteId = candidate.note_id;
    const n = await q.execute(
      `UPDATE driver_notes SET status = 'drafting', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'over_cap'`,
      [noteId, now],
    );
    if (n !== 1) return null;
  }

  const [row] = await q.query<{ trace_id: string; language: string }>(
    `SELECT CAST(trace_id AS text) AS trace_id, language FROM driver_notes
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [noteId],
  );
  const source = await readNoteSource(q, candidate.settlement_id);
  if (!row || !source) throw new Error("a reserved note has no settlement");
  const pack = buildPack(source);
  // The note keeps the language it was reserved in, even if the driver's setting changed since.
  if (row.language === "en" || row.language === "es") pack.language = row.language;
  return { noteId, traceId: row.trace_id, pack };
}

type Finish =
  | { status: "drafted"; body: string; citedSeqs: number[]; verification: object; modelCallId: string }
  | { status: "refused"; category: string; verification: object | null; modelCallId: string | null };

async function finishNote(db: TenantDb, session: Session, noteId: string, f: Finish, now: string): Promise<boolean> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const n = await q.execute(
      `UPDATE driver_notes
          SET status = $2, body = $3, cited_seqs = CAST($4 AS jsonb), verification = CAST($5 AS jsonb),
              refusal_category = $6, model_call_id = CAST($7 AS uuid), updated_at = CAST($8 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'drafting'`,
      [
        noteId,
        f.status,
        f.status === "drafted" ? f.body : null,
        JSON.stringify(f.status === "drafted" ? f.citedSeqs : []),
        f.verification === null ? null : JSON.stringify(f.verification),
        f.status === "refused" ? f.category : null,
        f.modelCallId,
        now,
      ],
    );
    return n === 1;
  });
}

// A note whose call never went out goes back to waiting for the next pass. Only a note still
// drafting that names no model call moves.
async function returnNote(db: TenantDb, session: Session, noteId: string, now: string): Promise<boolean> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const n = await q.execute(
      `UPDATE driver_notes SET status = 'over_cap', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'drafting'
          AND model_call_id IS NULL`,
      [noteId, now],
    );
    return n === 1;
  });
}

async function readSummary(q: Queryable, periodId: string) {
  const [row] = await q.query<Record<string, number | string>>(
    `SELECT count(*) AS total,
            count(n.id) FILTER (WHERE n.status IN ('drafted', 'approved', 'rejected')) AS drafted,
            count(n.id) FILTER (WHERE n.status = 'refused') AS refused,
            count(n.id) FILTER (WHERE n.status = 'over_cap') AS over_cap,
            count(n.id) FILTER (WHERE n.status = 'drafting') AS drafting,
            count(*) FILTER (WHERE n.id IS NULL) AS missing
       FROM settlements s
       LEFT JOIN driver_notes n ON n.tenant_id = s.tenant_id AND n.settlement_id = s.id
      WHERE s.tenant_id = current_tenant_id() AND s.period_id = CAST($1 AS uuid)
        AND s.status IN ('approved', 'paid')`,
    [periodId],
  );
  const num = (k: string) => Number(row?.[k] ?? 0);
  return {
    total: num("total"),
    drafted: num("drafted"),
    refused: num("refused"),
    overCap: num("over_cap"),
    drafting: num("drafting"),
    missing: num("missing"),
  };
}

export async function draftDriverNotes(
  session: Session,
  periodId: string,
  deadlineAt: Date,
  deps: DraftDeps = {},
): Promise<DraftSummary> {
  // Each switch is re-checked here, whoever calls; complete() checks aiEnabled again.
  if (!flags.driverNotesEnabled) return { ok: false, category: "disabled" };
  if (!flags.aiEnabled) return { ok: false, category: "ai_disabled" };
  const db = deps.db ?? getDb();
  const call = deps.complete ?? ((target, request, s) => complete(target, request, s));
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const iso = () => clock().toISOString();

  const candidates = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const period = await q.query<{ id: string }>(
      `SELECT CAST(id AS text) AS id FROM settlement_periods
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [periodId],
    );
    if (period.length !== 1) return null;
    // A note left drafting past its lease was cut off mid-call: it is never shown as approvable.
    await q.execute(
      `UPDATE driver_notes SET status = 'refused', refusal_category = 'interrupted',
              updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND period_id = CAST($1 AS uuid)
          AND status = 'drafting' AND updated_at < CAST($3 AS timestamptz)`,
      [periodId, iso(), new Date(clock().getTime() - DRAFTING_LEASE_MS).toISOString()],
    );
    return readCandidates(q, periodId);
  });
  if (candidates === null) return { ok: false, category: "not_found" };

  let written = 0;
  let stoppedBy: DraftStop = null;
  for (let i = 0; i < candidates.length; i++) {
    if (clock().getTime() + NOTE_TIMEOUT_MS > deadlineAt.getTime()) {
      stoppedBy = "deadline";
      break;
    }
    const claim = await db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      return claimNote(q, periodId, candidates[i], candidates.slice(i), newId, iso());
    });
    if (claim === "cap") {
      stoppedBy = "cap";
      break;
    }
    if (claim === null) continue;

    let result: AiResult;
    try {
      result = await call("spark", noteRequest(claim.pack, claim.traceId), session);
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      if (BEFORE_ANY_REQUEST.has(err.category)) {
        // No request went out: the note waits for the next pass with the rest.
        await returnNote(db, session, claim.noteId, iso());
      } else {
        // The category only; the row keeps no text. The rest wait for the next pass.
        await finishNote(db, session, claim.noteId, { status: "refused", category: err.category, verification: null, modelCallId: null }, iso());
        written += 1;
      }
      stoppedBy = "model";
      break;
    }
    let finish: Finish;
    if (result.status !== "ok") {
      // Cut off by the output budget: nothing was checked, so no check record is stored.
      finish = { status: "refused", category: "incomplete", verification: null, modelCallId: result.callId };
    } else {
      const checked = verifyNote(result.text, claim.pack);
      finish = checked.ok
        ? {
            status: "drafted",
            body: checked.body,
            citedSeqs: checked.citedSeqs,
            verification: checked.verification,
            modelCallId: result.callId,
          }
        : {
            status: "refused",
            category: checked.category,
            verification: checked.verification,
            modelCallId: result.callId,
          };
    }
    if (await finishNote(db, session, claim.noteId, finish, iso())) written += 1;
  }

  const counts = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return readSummary(q, periodId);
  });
  return { ok: true, ...counts, written, stoppedBy, more: stoppedBy === "deadline" };
}
