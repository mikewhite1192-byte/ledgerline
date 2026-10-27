import type { Queryable } from "../db";
import { readBySubject } from "../money/read";

// Whether a customer payment is in the accounting system or on its way there: its outside id is
// stored, or a customer_payment ledger row for it is reserved, sent or not yet known (anything but
// failed). A payment move is refused for such a payment by the limit, shown in the auditor's pack
// and refused by the executor, all through this one rule, so the two books never disagree. Agent
// tools import this file, so it imports only the database type and the ledger reader.
export async function paymentPostedOutside(
  q: Queryable,
  payment: { id: string; qbo_id: string | null },
): Promise<boolean> {
  if (payment.qbo_id !== null) return true;
  const rows = await readBySubject(q, "customer_payments", payment.id);
  return rows.some((a) => a.kind === "customer_payment" && a.state !== "failed");
}
