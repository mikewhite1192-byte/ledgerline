import { flags } from "../../config/flags";
import { factoringArgsOf, type FactoringArgs } from "../cash/args";
import type { Queryable } from "../db";
import { readCashFridayInput } from "../data/read";
import { computeCashFriday } from "../rules-engine";
import { factoringFor } from "../rules-engine/factoring";
import type { FactoringOption } from "../rules-engine/types";
import { localDateOf, type LocalDate } from "../time/local-date";
import { readFactoringInput } from "./read";

// The agent's factoring card (design 4.4): the rules engine's numbers for exactly the invoices the
// agent named, on the open week Cash Friday reads, with the short Cash Friday finds today. The
// limit and the tool's run both call this, in the same transaction, so the card the person sees
// carries the same cents the approval recomputes. Reads only.

export type FactoringProposal =
  | { ok: true; option: FactoringOption; args: FactoringArgs; today: LocalDate }
  // category: a Cash Friday refusal, "not_short" (the pay run is covered, so there is no short
  // for the card to name), or the engine's reason an invoice cannot be factored.
  | { ok: false; category: string; invoiceId: string | null };

export async function factoringProposalOf(
  q: Queryable,
  zone: string,
  now: Date,
  invoiceIds: readonly string[],
): Promise<FactoringProposal> {
  const today = localDateOf(now.toISOString(), zone);
  const limits = flags.cashFridayLimits;
  const cash = computeCashFriday(await readCashFridayInput(q, zone, limits), today);
  if (!cash.ok) return { ok: false, category: cash.refusal, invoiceId: null };
  if (cash.figures.gapCents >= 0) return { ok: false, category: "not_short", invoiceId: null };
  const shortCents = -cash.figures.gapCents;
  const d = factoringFor(
    await readFactoringInput(q, cash.periodId),
    invoiceIds,
    today,
    { maxAgeDays: limits.factoringMaxAgeDays, maxInvoices: limits.maxFactorInvoices },
    shortCents,
  );
  if (!d.ok) return { ok: false, category: d.category, invoiceId: d.invoiceId };
  return { ok: true, option: d.option, args: factoringArgsOf(d.option, cash.payDay, shortCents), today };
}
