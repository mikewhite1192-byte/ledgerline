import { z } from "zod";
import { readRowsWhereId } from "../../../../data/read";
import { compareText, PAY_ITEM_KINDS } from "../../../../rules-engine";
import { defineTool } from "../../types";
import { dateField, idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

export const getPayItems = defineTool({
  name: "get_pay_items",
  description:
    "List one driver's pay items (fuel, reimbursements, other deductions, carried shortfalls) " +
    "dated from periodStart to periodEnd (YYYY-MM-DD, both included), optionally only some kinds. " +
    "Money is in integer cents, always positive: a reimbursement adds to pay, the other kinds " +
    "deduct.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading pay items",
  args: z
    .strictObject({
      driverId: idField(),
      periodStart: dateField(),
      periodEnd: dateField(),
      kinds: z.array(z.enum(PAY_ITEM_KINDS)).max(PAY_ITEM_KINDS.length).optional(),
    })
    .refine((a) => a.periodStart <= a.periodEnd, {
      path: ["periodEnd"],
      message: "periodEnd before periodStart",
    }),
  refs: (a) => [{ table: "drivers", id: a.driverId }],
  run: async (q, _ctx, a) => {
    const items = await readRowsWhereId(q, "pay_items", "driver_id", a.driverId);
    const kinds = a.kinds ? new Set<string>(a.kinds) : null;
    const rows = items
      .filter((i) => i.item_date >= a.periodStart && i.item_date <= a.periodEnd)
      .filter((i) => !kinds || kinds.has(i.kind))
      .sort((x, y) => compareText(x.item_date, y.item_date) || compareText(x.item_ref, y.item_ref))
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        subkind: i.subkind,
        amountCents: i.amount_cents,
        itemDate: i.item_date,
        description: i.description,
        settled: i.settlement_id !== null,
        ref: i.ref_table && i.ref_id ? { table: i.ref_table, id: i.ref_id } : null,
      }));
    return { result: { driverId: a.driverId, rows } };
  },
});
