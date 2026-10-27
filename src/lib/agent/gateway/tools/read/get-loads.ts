import { z } from "zod";
import { readRowsWhereId } from "../../../../data/read";
import { compareText } from "../../../../rules-engine";
import { defineTool } from "../../types";
import { dateField, idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

export const getLoads = defineTool({
  name: "get_loads",
  description:
    "List one driver's loads, newest pickup first, optionally only pickups from one date to " +
    "another (YYYY-MM-DD, both included). Money is in integer cents.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading loads",
  args: z
    .strictObject({ driverId: idField(), from: dateField().optional(), to: dateField().optional() })
    .refine((a) => !a.from || !a.to || a.from <= a.to, { path: ["to"], message: "to before from" }),
  refs: (a) => [{ table: "drivers", id: a.driverId }],
  run: async (q, _ctx, a) => {
    const loads = await readRowsWhereId(q, "loads", "driver_id", a.driverId);
    const rows = loads
      .filter((l) => (!a.from || l.pickup_on >= a.from) && (!a.to || l.pickup_on <= a.to))
      .sort((x, y) => compareText(y.pickup_on, x.pickup_on) || compareText(x.load_number, y.load_number))
      .map((l) => ({
        id: l.id,
        loadNumber: l.load_number,
        customerId: l.customer_id,
        status: l.status,
        lane: `${l.origin_city}, ${l.origin_state} to ${l.dest_city}, ${l.dest_state}`,
        pickupOn: l.pickup_on,
        deliveredOn: l.delivered_on,
        loadedMiles: l.loaded_miles,
        emptyMiles: l.empty_miles,
        linehaulCents: l.linehaul_cents,
        fuelSurchargeCents: l.fuel_surcharge_cents,
      }));
    return { result: { driverId: a.driverId, rows } };
  },
});
