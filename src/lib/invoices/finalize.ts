import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import type { Queryable } from "../db";
import { readInvoiceQueueLoad } from "../data/read";
import { persistEngineProposal } from "../proposals/engine";
import { isLocalDate, type LocalDate } from "../time/local-date";
import { isUuid } from "../uuid";
import { tenantLock } from "./number";
import { invoiceDraftOf } from "./propose";
import { splitInvoiceQueue } from "./queue";

// TMS-MIRROR (S3): when the dispatch system finalizes one of our delivered loads, the desk drafts
// that load's invoice card, the same card Refresh on the invoice queue drafts (./propose.ts): the
// rules engine's total and lines from OUR loads row, never the dispatch system's revenue. It goes
// through persistEngineProposal, so the owner's limit mode decides whether a question is written,
// and approving it is the usual route and gate. Nothing here writes outside the app, and nothing
// moves money.
//
// Inside the desk's tenant transaction (src/lib/loads/movement.ts moveFromTmsEvent, which already
// asked tmsSync, its start date and loadMovement and holds the load's row lock). Takes turns with
// Refresh on the same tenant lock. The same load finalized twice is one card: one live card per
// kind and subject, equal args are a duplicate, and proposals' unique dedupe key is the backstop.

export type FinalizeOutcome =
  | { kind: "proposed"; proposalId: string; loadId: string }
  // Nothing for a person: switched off, before the start date, not in the queue, an engine
  // exception (its reason category), or a card that already stands for the load.
  | { kind: "nothing"; category: string };

// Whether a finalize on `day` (the carrier's local date) may draft a card. It asks the invoice
// queue's own switch too.
export function finalizeInvoiceOn(day: LocalDate): boolean {
  const s = flags.tmsFinalizeInvoice;
  return flags.invoicesEnabled === true && s.enabled === true && isLocalDate(s.startDate) && day >= s.startDate;
}

export async function proposeInvoiceOnFinalize(
  q: Queryable,
  session: Session,
  loadId: string,
  day: LocalDate,
  now: Date,
): Promise<FinalizeOutcome> {
  if (!isUuid(loadId) || !isLocalDate(day)) return { kind: "nothing", category: "validation" };
  // Off, the event is recorded like any other code that moves nothing.
  if (!finalizeInvoiceOn(day)) return { kind: "nothing", category: "recorded" };
  await tenantLock(q, "invoice_propose");
  const { loads, customers } = await readInvoiceQueueLoad(q, flags.invoicesStart, loadId);
  if (loads.length !== 1) return { kind: "nothing", category: "not_in_queue" };
  const queue = splitInvoiceQueue(loads, customers);
  const exception = queue.exceptions[0];
  if (exception) return { kind: "nothing", category: exception.reason };
  const item = queue.invoiceable[0];
  if (!item || item.load.id !== loadId) return { kind: "nothing", category: "not_in_queue" };
  const r = await persistEngineProposal(q, invoiceDraftOf(item), session, now);
  if (r.kind === "created") return { kind: "proposed", proposalId: r.proposalId, loadId };
  return { kind: "nothing", category: r.kind };
}
