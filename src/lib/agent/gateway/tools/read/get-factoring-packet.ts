import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readCashFridayInput } from "../../../../data/read";
import { packetGaps, packetsOf } from "../../../../factoring/packet";
import { readFactoringInput } from "../../../../factoring/read";
import { computeCashFriday } from "../../../../rules-engine";
import { factoringFor } from "../../../../rules-engine/factoring";
import { localDateOf } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

// The papers a factoring partner asks for with each invoice, and whether the rules engine would
// let each one be factored today (and if not, the engine's reason). Reads only; ids, never a
// file's contents.
export const getFactoringPacket = defineTool({
  name: "get_factoring_packet",
  description:
    "For each named invoice: whether the rules engine would let it be factored today (and if not, " +
    "the reason, such as invoice_too_old or invoice_already_factored), its net in integer cents if " +
    "it can be, and which papers are on file (the invoice, the rate confirmation, the bill of " +
    "lading, the proof of delivery) with the ids of the records behind them. This only reads.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Checking the factoring papers",
  enabled: () => flags.factoring?.enabled === true,
  args: z.strictObject({ invoiceIds: z.array(idField()).min(1).max(10) }),
  refs: (a): GatewayRef[] => a.invoiceIds.map((id): GatewayRef => ({ table: "invoices", id })),
  run: async (q, ctx, a) => {
    if (flags.factoring?.enabled !== true) throw new Error("factoring is switched off");
    const ids = [...new Set(a.invoiceIds)];
    const today = localDateOf(ctx.now.toISOString(), ctx.timeZone);
    const limits = flags.cashFridayLimits;
    // The open week Cash Friday reads; without one, no invoice can be factored.
    const cash = computeCashFriday(await readCashFridayInput(q, ctx.timeZone, limits), today);
    const input = cash.ok ? await readFactoringInput(q, cash.periodId) : null;
    const packets = await packetsOf(q, ids);
    return {
      result: {
        asOf: today,
        invoices: ids.map((id) => {
          const packet = packets.get(id) ?? null;
          // One invoice at a time, so each answer is that invoice's own; the short does not matter here.
          const d = input
            ? factoringFor(
                input,
                [id],
                today,
                { maxAgeDays: limits.factoringMaxAgeDays, maxInvoices: limits.maxFactorInvoices },
                1,
              )
            : null;
          return {
            invoiceId: id,
            factorable: d?.ok === true,
            refusal: d === null ? (cash.ok ? null : cash.refusal) : d.ok ? null : d.category,
            netCents: d?.ok === true ? d.option.amountCents : null,
            reserveCents: d?.ok === true ? d.option.reserveCents : null,
            packet,
            missing: packet ? packetGaps(packet) : null,
          };
        }),
      },
    };
  },
});
