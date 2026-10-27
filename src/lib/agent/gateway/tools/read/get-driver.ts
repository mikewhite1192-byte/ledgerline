import { z } from "zod";
import { readRowsWhereId } from "../../../../data/read";
import { defineTool } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

export const getDriver = defineTool({
  name: "get_driver",
  description:
    "Read one driver: code, name, worker type, pay basis and rates, advance limit, escrow " +
    "balance and active dates. Money is in integer cents.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading the driver",
  args: z.strictObject({ driverId: idField() }),
  refs: (a) => [{ table: "drivers", id: a.driverId }],
  run: async (q, _ctx, a) => {
    const [d] = await readRowsWhereId(q, "drivers", "id", a.driverId);
    if (!d) throw new Error("driver vanished after the ref check");
    return {
      result: {
        driver: {
          id: d.id,
          code: d.code,
          name: `${d.first_name} ${d.last_name}`,
          workerType: d.worker_type,
          payBasis: d.pay_basis,
          perMileCents: d.per_mile_cents,
          percentBps: d.percent_bps,
          flatPerLoadCents: d.flat_per_load_cents,
          advanceLimitCents: d.advance_limit_cents,
          escrowBalanceCents: d.escrow_balance_cents,
          truckUnit: d.truck_unit,
          activeFrom: d.active_from,
          activeTo: d.active_to,
        },
      },
    };
  },
});
