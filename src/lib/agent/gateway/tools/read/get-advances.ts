import { z } from "zod";
import { readRowsWhereId } from "../../../../data/read";
import { compareText } from "../../../../rules-engine";
import { defineTool } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

export const getAdvances = defineTool({
  name: "get_advances",
  description:
    "List one driver's pay advances, newest first: amount, fee, status and how much has been " +
    "recovered from settlements. Money is in integer cents.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading advances",
  args: z.strictObject({ driverId: idField() }),
  refs: (a) => [{ table: "drivers", id: a.driverId }],
  run: async (q, _ctx, a) => {
    const advances = await readRowsWhereId(q, "advances", "driver_id", a.driverId);
    const rows = advances
      .sort((x, y) => compareText(y.requested_at, x.requested_at) || compareText(x.id, y.id))
      .map((v) => ({
        id: v.id,
        requestedOn: v.requested_on,
        amountCents: v.amount_cents,
        feeCents: v.fee_cents,
        status: v.status,
        recoveredCents: v.recovered_cents,
        source: v.source,
        paidAt: v.paid_at,
      }));
    return { result: { driverId: a.driverId, rows } };
  },
});
