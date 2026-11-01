import type { CarrierPlan } from "../../../seed/plan";
import type { Handler, Row } from "./fake-db";

// The card check's reads (src/lib/data/card-recon.ts) served from one seed plan's rows, so the
// card tools run on the real readers and the real ranking with no database. Each read is matched
// by its own FROM clause; breaks come from a list a test passes (the seed writes none).

const between = (day: string, from: unknown, to: unknown) => day >= String(from) && day <= String(to);

export function cardReconHandler(plan: CarrierPlan, breaks: Row[] = []): Handler {
  const rows = plan.rows;
  return (sql, params) => {
    if (sql.includes("FROM card_recon_breaks b")) return breaks.map((b) => ({ ...b }));
    if (sql.includes("FROM card_transactions t") && sql.includes("AS card_on_file")) {
      const t = rows.card_transactions.find((x) => x.id === params[0]);
      if (!t) return [];
      return [
        {
          id: t.id,
          provider_ref: t.provider_ref,
          kind: t.kind,
          card_last4: t.card_last4,
          portal_name: t.portal_name,
          posted_on: t.posted_on,
          amount_cents: t.amount_cents,
          state: t.state,
          gallons_milli: t.gallons_milli,
          card_on_file: rows.driver_cards.some((c) => c.provider === t.provider && c.provider_token === t.card_token),
          purchase_on_file: rows.fuel_purchases.some((p) => p.purchase_ref === t.provider_ref),
        },
      ];
    }
    // The card check reads a driver's active dates without the money switch; the money gates read both.
    if (sql.includes("AS active_from") && sql.includes("FROM drivers") && !sql.includes("money_armed")) {
      return [...rows.drivers]
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        .map((d) => ({ id: d.id, code: d.code, active_from: d.active_from, active_to: d.active_to }));
    }
    if (sql.includes("FROM driver_days") && sql.startsWith("SELECT CAST(driver_id AS text)")) {
      return rows.driver_days
        .filter((d) => between(d.day, params[0], params[1]))
        .map((d) => ({ driver_id: d.driver_id, day: d.day, load_id: d.load_id }));
    }
    const dayLoads = () =>
      new Set(
        rows.driver_days
          .filter((d) => d.load_id !== null && between(d.day, params[0], params[1]))
          .map((d) => d.load_id as string),
      );
    if (sql.includes("FROM loads l") && sql.includes("l.origin_state")) {
      const ids = dayLoads();
      return rows.loads
        .filter((l) => ids.has(l.id))
        .map((l) => ({ id: l.id, origin_state: l.origin_state, dest_state: l.dest_state }));
    }
    if (sql.includes("FROM load_state_miles m")) {
      const ids = dayLoads();
      return rows.load_state_miles.filter((m) => ids.has(m.load_id)).map((m) => ({ load_id: m.load_id, state: m.state }));
    }
    if (sql.includes("FROM driver_cards WHERE")) {
      return rows.driver_cards.map((c) => ({
        driver_id: c.driver_id,
        provider_token: c.provider_token,
        portal_name: c.portal_name,
        status: c.status,
      }));
    }
    return undefined;
  };
}
