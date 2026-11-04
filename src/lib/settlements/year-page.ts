import { DbError } from "../db";
import { withRequestTenant } from "../tenant/context";
import { readPaystubYear, type PaystubYear } from "./year";

// A paystub page's year to date and escrow balance, in its own carrier transaction after the
// stub's own read, so a fault here never takes the paystub down: any failed read, missing row or
// bad value leaves the group out (null), and only the error's name or database category goes to the
// server log. The stub's own reads keep their errors.
export async function readPaystubYearForPage(settlementId: string): Promise<PaystubYear | null> {
  try {
    return await withRequestTenant((q) => readPaystubYear(q, settlementId));
  } catch (err) {
    const what = err instanceof DbError ? `database ${err.category}` : err instanceof Error ? err.name : "unknown";
    console.error(`paystub year read failed: ${what}`);
    return null;
  }
}
