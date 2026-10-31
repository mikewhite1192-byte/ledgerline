import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { localDateOf } from "../../../../time/local-date";
import { defineTool } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

// One driver's named deficits (driver_deficits, 0078 and 0080): money a person ruled the driver
// owes, how much pay has taken back so far and what is still owed, open and settled, oldest first.
// The note says where it came from in cents, a card's last four and a load number only. Behind
// deficit recovery's switch, read on every offer and every call, and again here. The model reads
// and explains "what does he owe"; the rules engine takes it back from pay and a person approves
// the stub.

export const DEFICIT_LIMIT = 50;

type Row = {
  id: string;
  amount_cents: string;
  recovered_cents: string;
  source_kind: string;
  note: string;
  settled_in: string | null;
  proposal_id: string | null;
  created_at: unknown;
};

const SQL = `SELECT CAST(id AS text) AS id, CAST(amount_cents AS text) AS amount_cents,
       CAST(recovered_cents AS text) AS recovered_cents, source_kind, note,
       CAST(settled_in AS text) AS settled_in, CAST(proposal_id AS text) AS proposal_id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
  FROM driver_deficits
 WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)
 ORDER BY created_at, id
 LIMIT ${DEFICIT_LIMIT}`;

function whole(value: string, what: string): number {
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) throw new Error(`${what} did not read as whole cents`);
  return n;
}

export const getDriverDeficits = defineTool({
  name: "get_driver_deficits",
  description:
    "List what one driver owes by a person's ruling (a fuel card load with no payment record, or a " +
    "card pull-back the card could not cover), oldest first, open and settled: the amount, what pay " +
    "has taken back so far and what is still owed, in integer cents, where it came from, the day it " +
    "was booked and the paystub that settled it. owedCents sums what is still owed.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading what the driver owes",
  enabled: () => flags.deficitRecovery.enabled,
  args: z.strictObject({ driverId: idField() }),
  refs: (a) => [{ table: "drivers", id: a.driverId }],
  run: async (q, ctx, a) => {
    if (!flags.deficitRecovery.enabled) throw new Error("deficit recovery is switched off");
    const found = await q.query<Row>(SQL, [a.driverId]);
    let owed = 0;
    const rows = found.map((r) => {
      if (typeof r.created_at !== "string") throw new Error("driver_deficits.created_at did not read as text");
      const amount = whole(r.amount_cents, "amount");
      const recovered = whole(r.recovered_cents, "recovered");
      const left = amount - recovered;
      owed += left;
      return {
        id: r.id,
        bookedOn: localDateOf(r.created_at, ctx.timeZone),
        sourceKind: r.source_kind,
        note: r.note,
        amountCents: amount,
        recoveredCents: recovered,
        stillOwedCents: left,
        status: r.settled_in === null ? "open" : "settled",
        settledIn: r.settled_in,
        proposalId: r.proposal_id,
      };
    });
    return { result: { driverId: a.driverId, owedCents: owed, rows } };
  },
});
