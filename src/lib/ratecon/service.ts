import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { requireStaff } from "../auth/role";
import { untrustedContentHash } from "../data/content-hash";
import { readTenant } from "../data/read";
import { getDb, type Queryable, type TenantDb } from "../db";
import { readDocumentBytes, readDocumentMeta } from "../documents/store";
import { persistEngineProposal } from "../proposals/engine";
import { assertMembership } from "../tenant/context";
import { localDateOf } from "../time/local-date";
import type { LoadCreateArgs } from "./args";
import { rateConCandidates } from "./candidates";
import { checkRateCon, type RateConRefusal } from "./check";
import { readRateCon, type RateConReadDeps, type RateConReadOutcome } from "./read";
import { parseRateCon, rawOfRateCon, rateConTranscriptOf, type RateConReading } from "./schema";
import {
  claimRateConTry,
  countRateConCards,
  countRecentRateCons,
  endRateConCard,
  finishRateCon,
  insertRateConBeforeStart,
  insertRateConRow,
  insertRateConTranscript,
  lockTenantRateCons,
  RATECON_ATTEMPTS_MAX,
  RATECON_CARDS_MAX,
  readCardStatus,
  readRateConRow,
  readTranscriptRow,
  relinkRateConCard,
  type RateConFinish,
  type RateConRow,
  type RateConRowEnd,
  type RateConStatus,
} from "./store";

// A rate confirmation for a load no record holds becomes a load_create card a person approves.
// What the route (and, once inbound mail forwards attachments, the mail route with the service
// session) calls, after uploadDocument has stored and read the file. Each step opens its own short
// tenant transaction with the membership and staff checks; the model read runs between them,
// never inside one (it can take 25 seconds).
//
// Step 1, under the tenant's rate confirmation lock: the document is this tenant's PDF, read, a
// rate confirmation, and its first read found no record for it. Its row is taken: a card still
// live (or the load it made) is returned as it is (no second read, no second charge); a card that
// expired or failed is followed by a new one, in this step with no model call, from the stored
// reading (its transcript must still hash to it, every check runs again, the reserved load id is
// again the subject, at most RATECON_CARDS_MAX cards per document); a card a person rejected ends
// the row refused with no tries left, so the same file never brings it back (a corrected file is
// its own document). A row that ended with no card gets another try while tries are left; a
// pending one younger than two minutes is in progress, an older one's request went away and is
// taken with a lease. A new row for a document stored before
// the start date is inserted refused (before_start) with no tries left, so it is never read; any
// other is refused past the daily count, then inserted pending with the load id reserved. Step 2,
// the read. Step 3, under the same lock with the row still pending at the same count: the
// transcript is stored as an outside input, every value checked against the records, and the row
// ends refused (a category) or proposed (the card). A read whose outcome is not known (or not made
// because a switch went off) leaves the row pending, so it can be tried again later.
//
// Dedupe keys, named: the file is documents (tenant_id, content_hash) (uploadDocument); the read is
// ratecon_reads (tenant_id, document_id); the card is proposals.dedupe_key
// load_create:<load_id>:<sha256(args)> (args.revision, the load id's cards that ended expired or
// failed, sets each new card's key apart) plus one live card per (kind, subject); the load is
// loads.id = the reserved load_id plus loads (tenant_id, load_number) (the executor).

export const RATECON_STALLED_MS = 2 * 60 * 1000;

export type RateConServiceDeps = { db?: TenantDb; now?: () => Date; read?: RateConReadDeps };

export type RateConView = {
  documentId: string;
  status: RateConStatus;
  category: string | null;
  proposalId: string | null;
  attemptsLeft: number;
};

export type LoadCardRefusal =
  | "disabled"
  | "not_found"
  | "not_rate_confirmation"
  | "has_record"
  | "in_progress"
  | "attempt_limit"
  | "limit";

export type LoadCardOutcome = { ok: true; view: RateConView } | { ok: false; error: LoadCardRefusal };

const viewOf = (row: RateConRow): RateConView => ({
  documentId: row.document_id,
  status: row.status,
  category: row.category,
  proposalId: row.proposal_id,
  attemptsLeft: Math.max(0, RATECON_ATTEMPTS_MAX - Number(row.attempts)),
});

function tx<T>(db: TenantDb, session: Session, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    await requireStaff(q, session);
    return fn(q);
  });
}

// Only a first read that found no load for the number: a stored match reads exactly
// { found: false, reason: "no_record" }; anything else (or a match that does not read) is not.
function noRecord(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const m = v as Record<string, unknown>;
    return m.found === false && m.reason === "no_record";
  } catch {
    return false;
  }
}

// The document was stored before flags.ratecon.startDate, on the carrier's own calendar: the test
// check.ts makes after a read, made here before one.
async function beforeStart(q: Queryable, createdAt: string): Promise<boolean> {
  const tenant = await readTenant(q);
  if (!tenant || typeof tenant.timezone !== "string" || tenant.timezone === "") {
    throw new Error("no tenant for the transaction");
  }
  return localDateOf(createdAt, tenant.timezone) < flags.ratecon.startDate;
}

export type CardFate = "live" | "dead" | "rejected";

// What a proposed row's card leaves it: waiting, approved, running or done is live (the row is
// returned as it is); expired or failed is dead (a new card may follow); rejected ends the row.
// Any other status, or no card read, is live: unknown is not dead, so nothing is made from it.
export function cardFateOf(status: string | null): CardFate {
  if (status === "expired" || status === "failed") return "dead";
  if (status === "rejected") return "rejected";
  return "live";
}

type Carded = { ok: true; proposalId: string } | { ok: false; category: RateConRefusal };

// The card a reading makes, inside the caller's transaction under the tenant's lock: the records
// read, every check run, and the card persisted with the reserved load id as its subject. A first
// read's finish and a dead card's follow-up both come here, so the two cannot drift.
async function cardFromReading(
  q: Queryable,
  session: Session,
  ids: { loadId: string; documentId: string; inputId: string },
  reading: RateConReading,
  documentCreatedAt: string,
  now: Date,
): Promise<Carded> {
  const candidates = await rateConCandidates(q, reading, ids.loadId);
  const checked = checkRateCon(reading, candidates, { now, documentCreatedAt, startDate: flags.ratecon.startDate });
  if (!checked.ok) return { ok: false, category: checked.category };
  const args: LoadCreateArgs = {
    v: 1,
    loadId: ids.loadId,
    documentId: ids.documentId,
    inputId: ids.inputId,
    readingHash: untrustedContentHash("document", rateConTranscriptOf(reading)),
    ...checked.draft,
  };
  const persisted = await persistEngineProposal(
    q,
    {
      kind: "load_create",
      subjectTable: "loads",
      subjectId: ids.loadId,
      amountCents: checked.draft.totalCents,
      args,
      exceptions: [],
      reasons: ["rate_confirmation"],
      sources: [
        { table: "customers", id: checked.draft.customerId },
        { table: "untrusted_inputs", id: ids.inputId },
      ],
    },
    session,
    now,
  );
  if (persisted.kind !== "created" && persisted.kind !== "duplicate") return { ok: false, category: "card_exists" };
  return { ok: true, proposalId: persisted.proposalId };
}

// A proposed row whose card is dead or rejected, inside the step 1 transaction (the tenant's lock
// held, the row locked), with no model call. A rejected card ends the row with no tries left. An
// expired or failed one is followed by a new card from the stored reading, only while the stored
// transcript is exactly that reading's text and hashes to it (any miss is not_executable, never a
// card), the load id has had fewer than RATECON_CARDS_MAX cards (card_limit, no tries left), and
// every check takes it again (a refusal keeps its tries, so a later request may read again).
async function followDeadCard(
  q: Queryable,
  session: Session,
  row: RateConRow,
  cardId: string,
  fate: Exclude<CardFate, "live">,
  documentCreatedAt: string,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const end = async (category: RateConRefusal | RateConRowEnd | "not_executable"): Promise<void> => {
    if ((await endRateConCard(q, row.id, cardId, category, nowIso)) !== 1) {
      throw new Error("rate confirmation row could not be ended");
    }
  };
  if (fate === "rejected") return end("rejected");
  const reading = row.reading === null ? null : parseRateCon(row.reading);
  const stored = row.input_id === null ? null : await readTranscriptRow(q, row.input_id);
  if (!reading || !stored || row.input_id === null) return end("not_executable");
  const transcript = rateConTranscriptOf(reading);
  if (stored.body_text !== transcript || stored.content_hash !== untrustedContentHash("document", transcript)) {
    return end("not_executable");
  }
  if ((await countRateConCards(q, row.load_id)) >= RATECON_CARDS_MAX) return end("card_limit");
  const ids = { loadId: row.load_id, documentId: row.document_id, inputId: row.input_id };
  const made = await cardFromReading(q, session, ids, reading, documentCreatedAt, now);
  if (!made.ok) return end(made.category);
  if ((await relinkRateConCard(q, row.id, cardId, made.proposalId, nowIso)) !== 1) {
    throw new Error("rate confirmation row could not take its new card");
  }
}

type Claimed =
  | { done: LoadCardOutcome }
  | { row: Pick<RateConRow, "id" | "attempts" | "load_id">; bytes: Uint8Array; traceId: string; createdAt: string };

async function claim(q: Queryable, session: Session, documentId: string, now: Date): Promise<Claimed> {
  const nowIso = now.toISOString();
  await lockTenantRateCons(q);
  const doc = await readDocumentMeta(q, documentId);
  if (!doc) return { done: { ok: false, error: "not_found" } };
  if (doc.mime !== "application/pdf" || doc.read_status !== "read" || doc.document_kind !== "rate_confirmation") {
    return { done: { ok: false, error: "not_rate_confirmation" } };
  }
  if (!noRecord(doc.match)) return { done: { ok: false, error: "has_record" } };

  let row = await readRateConRow(q, documentId, { lock: true });
  if (row) {
    if (row.status === "proposed" && row.proposal_id !== null) {
      const fate = cardFateOf(await readCardStatus(q, row.proposal_id));
      if (fate !== "live") {
        await followDeadCard(q, session, row, row.proposal_id, fate, doc.created_at, now);
        const after = await readRateConRow(q, documentId);
        if (!after) throw new Error("rate confirmation row vanished");
        // The same line a read writes, so a new card or a row ended here shows in the logs; no read, no cost.
        console.info(
          `ratecon: document ${documentId} status=${after.status} category=${after.category ?? "none"} cost=0 card=${fate}`,
        );
        return { done: { ok: true, view: viewOf(after) } };
      }
    }
    if (row.status === "proposed" || row.status === "created") return { done: { ok: true, view: viewOf(row) } };
    const cutoff = new Date(now.getTime() - RATECON_STALLED_MS).toISOString();
    if (row.status === "pending" && row.updated_at >= cutoff) return { done: { ok: false, error: "in_progress" } };
    if (Number(row.attempts) >= RATECON_ATTEMPTS_MAX) return { done: { ok: false, error: "attempt_limit" } };
    const attempts = Number(row.attempts);
    if ((await claimRateConTry(q, { id: row.id, status: row.status, attempts }, cutoff, nowIso)) !== 1) {
      return { done: { ok: false, error: "in_progress" } };
    }
    row = { ...row, attempts: attempts + 1 };
  } else {
    if (await beforeStart(q, doc.created_at)) {
      const refused = { id: randomUUID(), documentId, loadId: randomUUID() };
      if ((await insertRateConBeforeStart(q, refused, nowIso)) !== 1) {
        throw new Error("rate confirmation row insert took no row");
      }
      const stored = await readRateConRow(q, documentId);
      if (!stored || stored.load_id !== refused.loadId) throw new Error("rate confirmation row could not be read back");
      return { done: { ok: true, view: viewOf(stored) } };
    }
    if ((await countRecentRateCons(q, nowIso)) >= flags.ratecon.perTenantPerDay) {
      return { done: { ok: false, error: "limit" } };
    }
    const fresh = { id: randomUUID(), documentId, loadId: randomUUID() };
    if ((await insertRateConRow(q, fresh, nowIso)) !== 1) throw new Error("rate confirmation row insert took no row");
    row = await readRateConRow(q, documentId, { lock: true });
    if (!row || row.load_id !== fresh.loadId) throw new Error("rate confirmation row could not be read back");
  }
  const file = await readDocumentBytes(q, documentId);
  if (!file || file.mime !== "application/pdf") return { done: { ok: false, error: "not_found" } };
  const bytes = new Uint8Array(Buffer.from(file.base64.replace(/\s+/g, ""), "base64"));
  return {
    row: { id: row.id, attempts: Number(row.attempts), load_id: row.load_id },
    bytes,
    traceId: doc.trace_id,
    createdAt: doc.created_at,
  };
}

// The try's end, from the read's outcome, inside the step 3 transaction (the row locked, pending).
async function finishFor(
  q: Queryable,
  session: Session,
  claimed: Extract<Claimed, { row: unknown }>,
  documentId: string,
  outcome: Exclude<RateConReadOutcome, { status: "retry" }>,
  now: Date,
): Promise<RateConFinish> {
  if (!outcome.ok) return { status: outcome.status, category: outcome.category, callId: outcome.callId };
  const nowIso = now.toISOString();
  const transcript = rateConTranscriptOf(outcome.reading);
  const inputId = await insertRateConTranscript(q, transcript, nowIso);
  const reading = rawOfRateCon(outcome.reading);
  const ids = { loadId: claimed.row.load_id, documentId, inputId };
  const made = await cardFromReading(q, session, ids, outcome.reading, claimed.createdAt, now);
  if (!made.ok) return { status: "refused", category: made.category, reading, inputId, callId: outcome.callId };
  return { status: "proposed", reading, inputId, callId: outcome.callId, proposalId: made.proposalId };
}

export async function createLoadCard(
  session: Session,
  documentId: string,
  deps: RateConServiceDeps = {},
): Promise<LoadCardOutcome> {
  if (!flags.documentsEnabled || !flags.ratecon.enabled) return { ok: false, error: "disabled" };
  const db = deps.db ?? getDb();
  const clock = deps.now ?? (() => new Date());
  const claimed = await tx(db, session, (q) => claim(q, session, documentId, clock()));
  if ("done" in claimed) return claimed.done;

  const outcome = await readRateCon({ documentId, bytes: claimed.bytes, traceId: claimed.traceId }, session, deps.read);
  const now = clock();
  const row = await tx(db, session, async (q) => {
    await lockTenantRateCons(q);
    const current = await readRateConRow(q, documentId, { lock: true });
    if (!current) throw new Error("rate confirmation row vanished");
    // Only the try this request holds is ended; a read whose outcome is not known ends nothing.
    const held = current.status === "pending" && Number(current.attempts) === claimed.row.attempts;
    if (held && (outcome.ok || outcome.status !== "retry")) {
      const finish = await finishFor(q, session, claimed, documentId, outcome, now);
      if ((await finishRateCon(q, claimed.row, finish, now.toISOString())) !== 1) {
        throw new Error("rate confirmation row could not be finished");
      }
    }
    const after = await readRateConRow(q, documentId);
    if (!after) throw new Error("rate confirmation row vanished");
    return after;
  });
  const cost = outcome.ok ? outcome.costNanocents : 0;
  console.info(
    `ratecon: document ${documentId} status=${row.status} category=${row.category ?? "none"} cost=${cost}`,
  );
  return { ok: true, view: viewOf(row) };
}
