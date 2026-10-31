import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { Queryable } from "../db";
import { readTenantZone } from "../money/read";
import { persistEngineProposal, type EngineDraft } from "../proposals/engine";
import { isLocalDate, localDateOf, type LocalDate } from "../time/local-date";
import { isUuid } from "../uuid";
import { LOCK_LOAD_SQL, cardDriver, hasLedgerRow, hasOtherDeficit, loadCents, readLoadRow } from "./facts";

// CARD-LOAD-RULING: a fuel card load on the card statement (card_transactions, kind 'load') with no
// payment record behind it gets one card_load_ruling card, for a named person to rule on whether
// the driver whose card it is owes it. Code drafts the card, here; the model writes nothing. The
// card is drafted as a deficit for the full load amount: Yes books it, an edit to owes_nothing
// records the ruling with no deficit (src/lib/proposals/executors/card-load-ruling.ts). It goes
// through the same approval gate as any card, and never to the autopilot (the kind is never alone).
//
// One card per statement row: proposals_one_live_per_subject keeps one live card per row, and the
// dedupe key (kind, row and the canonical args) keeps a decided card decided, a rejected one
// included, while its content is the same. Two runs on one row take turns on its advisory lock,
// so the second finds the first's card. The desk loop's card_transaction source calls this once
// per row (its desk_log key is card_transaction:<id>).
//
// A row that reached the records before the start date (the carrier's local midnight) is backlog
// and drafts nothing, so turning this on never reaches back to statements already read.

export type RulingSkip =
  | "switched_off"
  | "before_start"
  | "not_found"
  | "not_load"
  | "ledger_row"
  | "no_driver"
  | "already"
  | "already_decided";

export type RulingDraftOutcome =
  | { kind: "proposed"; proposalId: string; amountCents: number }
  | { kind: "nothing"; category: RulingSkip };

// Whether the ruling may draft for a row that reached the records on `day` (the carrier's local date).
export function cardLoadRulingOn(day: LocalDate): boolean {
  const s = flags.cardLoadRuling;
  return s.enabled === true && isLocalDate(s.startDate) && day >= s.startDate;
}

const nothing = (category: RulingSkip): RulingDraftOutcome => ({ kind: "nothing", category });

// Inside a tenant transaction the caller holds, after assertMembership.
export async function proposeCardLoadRuling(
  q: Queryable,
  session: Session,
  transactionId: string,
  now: Date,
): Promise<RulingDraftOutcome> {
  if (flags.cardLoadRuling.enabled !== true) return nothing("switched_off");
  if (!isUuid(transactionId)) return nothing("not_found");
  const id = transactionId.toLowerCase();
  const seen = await readLoadRow(q, id);
  if (!seen) return nothing("not_found");
  if (seen.kind !== "load") return nothing("not_load");

  const zone = await readTenantZone(q);
  for (const instant of [seen.created_at, now.toISOString()]) {
    if (!cardLoadRulingOn(localDateOf(instant, zone))) return nothing("before_start");
  }

  // Take the row's turn, then read it again under the lock.
  await q.query(LOCK_LOAD_SQL, [id]);
  const row = await readLoadRow(q, id);
  if (!row) return nothing("not_found");
  if (row.kind !== "load") return nothing("not_load");
  const amountCents = loadCents(row);
  if (amountCents === null) return nothing("not_found");

  if (await hasLedgerRow(q, row.provider_ref)) return nothing("ledger_row");
  // A ruling already booked what the driver owes on this row.
  if (await hasOtherDeficit(q, id, null)) return nothing("already_decided");
  const driverId = await cardDriver(q, row.provider, row.card_token);
  // A card on no driver's file is the card check's "card not on file" difference, not a ruling.
  if (driverId === null) return nothing("no_driver");

  const draft: EngineDraft = {
    kind: "card_load_ruling",
    subjectTable: "card_transactions",
    subjectId: id,
    amountCents,
    args: {
      transactionId: id,
      providerRef: row.provider_ref,
      amountCents,
      driverId,
      cardLast4: row.card_last4,
      postedOn: row.posted_on,
      ruling: "deficit",
    },
    exceptions: [],
    reasons: ["load_not_in_ledger"],
    sources: [
      { table: "card_transactions", id },
      { table: "drivers", id: driverId },
    ],
    operatorVerdict: "card_load_unexplained",
  };
  const r = await persistEngineProposal(q, draft, session, now);
  if (r.kind === "created") return { kind: "proposed", proposalId: r.proposalId, amountCents };
  if (r.kind === "duplicate") return nothing("already");
  return nothing("already_decided");
}
