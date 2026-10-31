import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { TenantDb } from "../db";
import { readInvoiceQueue } from "../data/read";
import { persistEngineProposal, retireEngineProposalsExcept, type EngineDraft } from "../proposals/engine";
import { assertMembership } from "../tenant/context";
import { tenantLock } from "./number";
import { lineSummary, splitInvoiceQueue, type InvoiceableLoad } from "./queue";

// "Refresh" on the invoice queue: one engine proposal per delivered load the rules engine can
// invoice, each carrying the engine's total and lines. Never on a schedule; a person presses it.
// Proposing twice changes nothing (the dedupe key is the args hash); a load whose total changed
// gets a new card and the old waiting card is retired; a load that is no longer invoiceable (an
// exception now, invoiced another way, out of the queue) has its waiting card retired. At most
// invoiceLimits.proposalsPerRun new cards per press, the rest next time.
// Nothing here writes outside the app, and nothing moves money.

export type ProposeCounts = {
  created: number;
  unchanged: number;
  // An approved or running card already stands for the load; its executor re-checks the total.
  inFlight: number;
  // A person already decided the same content (rejected it, say); it is not asked again.
  decided: number;
  retired: number;
  exceptions: number;
  truncated: boolean;
};

export type ProposeResult = { ok: true; counts: ProposeCounts } | { ok: false; category: "disabled" };

// One invoiceable load's card, as Refresh and the dispatch finalize hook (./finalize.ts) both draft
// it. Pure. The dedupe key is a hash of these args, so both paths must draft the same args for the
// same load: a differing arg would make each one retire the other's card.
export function invoiceDraftOf(item: InvoiceableLoad): EngineDraft {
  return {
    kind: "invoice_post",
    subjectTable: "loads",
    subjectId: item.load.id,
    amountCents: item.amountCents,
    args: {
      loadId: item.load.id,
      loadNumber: item.load.loadNumber,
      amountCents: item.amountCents,
      lines: lineSummary(item.lines),
    },
    exceptions: [],
    reasons: ["engine_total"],
    sources: [...item.sources, ...item.lines.flatMap((l) => l.sources)],
  };
}

export async function proposeInvoices(db: TenantDb, session: Session, now: Date): Promise<ProposeResult> {
  if (!flags.invoicesEnabled) return { ok: false, category: "disabled" };
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    // Two presses at once take turns, so neither sees the other's half-made cards.
    await tenantLock(q, "invoice_propose");
    const { loads, customers } = await readInvoiceQueue(q, flags.invoicesStart);
    const queue = splitInvoiceQueue(loads, customers);
    const counts: ProposeCounts = {
      created: 0,
      unchanged: 0,
      inFlight: 0,
      decided: 0,
      retired: 0,
      exceptions: queue.exceptions.length,
      truncated: false,
    };
    for (const item of queue.invoiceable) {
      // The cap counts new cards only, so the next press walks past the unchanged ones to the rest.
      if (counts.created >= flags.invoiceLimits.proposalsPerRun) {
        counts.truncated = true;
        break;
      }
      const result = await persistEngineProposal(q, invoiceDraftOf(item), session, now);
      if (result.kind === "created") counts.created += 1;
      else if (result.kind === "duplicate") counts.unchanged += 1;
      else if (result.kind === "live_exists") counts.inFlight += 1;
      else counts.decided += 1;
    }
    // Every press, whatever the cap: a waiting card whose load is no longer invoiceable is retired.
    const invoiceable = new Set(queue.invoiceable.map((i) => i.load.id));
    counts.retired += await retireEngineProposalsExcept(q, "invoice_post", invoiceable, session, now);
    return { ok: true, counts };
  });
}
