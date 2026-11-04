import { z } from "zod";
import { activeOn } from "../../../../drivers/active";
import { localDateOf } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { OPERATOR_AUDITOR } from "../shared";

// The most drivers one search returns; more says there were others.
export const FIND_DRIVER_CAP = 10;

// A driver by any part of the name or code, this carrier's only (RLS and the tenant filter, as
// every read). $1 is the pattern, its LIKE wildcards escaped; it reads one more than the cap, so
// a full page says whether more matched.
export const FIND_DRIVER_SQL =
  "SELECT id, code, first_name, last_name, CAST(active_from AS text) AS active_from," +
  " CAST(active_to AS text) AS active_to FROM drivers" +
  " WHERE tenant_id = current_tenant_id() AND (first_name ILIKE $1 OR last_name ILIKE $1" +
  " OR (first_name || ' ' || last_name) ILIKE $1 OR code ILIKE $1)" +
  " ORDER BY last_name, first_name, code, id LIMIT " +
  String(FIND_DRIVER_CAP + 1);

// The text as a contains pattern: the LIKE wildcards and the escape character match themselves.
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

type Row = {
  id: string;
  code: string;
  first_name: string;
  last_name: string;
  active_from: string;
  active_to: string | null;
};

export const findDriver = defineTool({
  name: "find_driver",
  description:
    "Find drivers by name or driver code: any part of the first name, last name, full name or " +
    "code, ignoring case. Each match has driverId, code, name and status (active, or inactive " +
    "when they no longer drive for the carrier today); at most 10, by last name, and more true " +
    "when others matched. A question that names a driver starts here, in the same response as " +
    "set_checklist; the driverId goes to get_advances, explain_paystub, get_driver, run_checks " +
    "and the other tools that take one. This only reads.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Finding the driver",
  args: z.strictObject({
    name: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .regex(/^[^\p{Cc}]+$/u),
  }),
  refs: (): GatewayRef[] => [],
  run: async (q, ctx, a) => {
    const today = localDateOf(ctx.now.toISOString(), ctx.timeZone);
    const rows = await q.query<Row>(FIND_DRIVER_SQL, [containsPattern(a.name)]);
    return {
      result: {
        drivers: rows.slice(0, FIND_DRIVER_CAP).map((d) => ({
          driverId: d.id,
          code: d.code,
          name: `${d.first_name} ${d.last_name}`.trim(),
          status: activeOn(d.active_from, d.active_to, today) ? "active" : "inactive",
        })),
        more: rows.length > FIND_DRIVER_CAP,
      },
    };
  },
});
