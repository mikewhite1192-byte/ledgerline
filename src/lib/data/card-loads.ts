import type { Queryable } from "../db";
import type { Period } from "../time/local-date";

// The fuel card loads on the card statement in a window, for the agent's get_card_loads read
// (CARD-LOAD-RULING): whether a payment record stands behind each, whose card it is, and the
// newest ruling on it. SELECT only, every table naming its tenant (`tenant_id =
// current_tenant_id()`), so a login that bypasses row-level security still reads one carrier. The
// card's token is compared inside SQL only and never read out; a card shows by its last four.

export const CARD_LOADS_MAX = 50;

export type CardLoadRuling = {
  proposalId: string;
  status: string;
  // The ruling a person made (decision_note on a done card), else null.
  ruling: "owes_nothing" | "deficit" | null;
  decidedBy: "staff" | "admin" | null;
  // The deficit it booked, in integer cents, or null for none.
  deficitCents: number | null;
};

export type CardLoad = {
  id: string;
  postedOn: string;
  cardLast4: string;
  amountCents: number;
  driver: { id: string; code: string } | null;
  // A ledger row on the card provider names the load (any state but failed: unknown is a record).
  record: "recorded" | "no_record";
  ruling: CardLoadRuling | null;
};

type Row = {
  id: string;
  posted_on: string;
  card_last4: string;
  amount_cents: string;
  driver_id: string | null;
  driver_code: string | null;
  recorded: boolean;
  proposal_id: string | null;
  proposal_status: string | null;
  decision_note: string | null;
  decided_role: string | null;
  deficit_cents: string | null;
};

const SQL = `
  SELECT CAST(t.id AS text) AS id, CAST(t.posted_on AS text) AS posted_on, t.card_last4,
         CAST(t.amount_cents AS text) AS amount_cents,
         CAST(d.id AS text) AS driver_id, d.code AS driver_code,
         EXISTS (SELECT 1 FROM money_actions m
                  WHERE m.tenant_id = t.tenant_id AND m.outside_system = 'fuel_card_sim'
                    AND m.outside_id = t.provider_ref AND m.state <> 'failed') AS recorded,
         CAST(p.id AS text) AS proposal_id, p.status AS proposal_status, p.decision_note,
         (SELECT mb.role FROM memberships mb
           WHERE mb.tenant_id = t.tenant_id AND mb.cognito_sub = p.decided_by) AS decided_role,
         (SELECT CAST(dd.amount_cents AS text) FROM driver_deficits dd
           WHERE dd.tenant_id = t.tenant_id AND dd.source_kind = 'card_load' AND dd.source_id = t.id) AS deficit_cents
    FROM card_transactions t
    LEFT JOIN driver_cards c ON c.tenant_id = t.tenant_id AND c.provider = t.provider
                            AND c.provider_token = t.card_token
    LEFT JOIN drivers d ON d.tenant_id = c.tenant_id AND d.id = c.driver_id
    LEFT JOIN LATERAL (
      SELECT pr.id, pr.status, pr.decision_note, pr.decided_by FROM proposals pr
       WHERE pr.tenant_id = t.tenant_id AND pr.kind = 'card_load_ruling' AND pr.subject_id = t.id
       ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) p ON true
   WHERE t.tenant_id = current_tenant_id() AND t.kind = 'load'
     AND t.posted_on BETWEEN CAST($1 AS date) AND CAST($2 AS date)
   ORDER BY t.posted_on DESC, t.id
   LIMIT CAST($3 AS integer)`;

const cents = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
};

const RULED = new Set(["owes_nothing", "deficit"]);

export async function readCardLoads(q: Queryable, window: Period, limit: number): Promise<CardLoad[]> {
  const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, CARD_LOADS_MAX) : CARD_LOADS_MAX;
  const rows = await q.query<Row>(SQL, [window.start, window.end, n]);
  return rows.flatMap((r) => {
    const amountCents = cents(r.amount_cents);
    // A row whose cents do not read is left out, never shown as zero.
    if (amountCents === null) return [];
    const ruling: CardLoadRuling | null =
      r.proposal_id === null || r.proposal_status === null
        ? null
        : {
            proposalId: r.proposal_id,
            status: r.proposal_status,
            ruling:
              r.proposal_status === "done" && r.decision_note !== null && RULED.has(r.decision_note)
                ? (r.decision_note as CardLoadRuling["ruling"])
                : null,
            decidedBy: r.decided_role === "staff" || r.decided_role === "admin" ? r.decided_role : null,
            deficitCents: cents(r.deficit_cents),
          };
    return [
      {
        id: r.id,
        postedOn: r.posted_on,
        cardLast4: r.card_last4,
        amountCents,
        driver: r.driver_id !== null && r.driver_code !== null ? { id: r.driver_id, code: r.driver_code } : null,
        record: r.recorded === true ? "recorded" : "no_record",
        ruling,
      },
    ];
  });
}
