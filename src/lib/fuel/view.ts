import { readProposalViews } from "../agent/gateway/store/views";
import type { ProposalView } from "../agent/view";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import type { FuelCheckName, NoSuggestionReason } from "../rules-engine/fuel";
import { assertMembership } from "../tenant/context";
import { fuelSentence, stateName } from "./help";

// What the fuel checks page shows (FUEL-ANOMALY design 4.6): rows only, every number from the
// database, every sentence a fixed template. A record is named by its human ref (the fill-up's
// receipt number, the load number, the pay line's ref), never its id.

export type FuelRunView = {
  status: "running" | "done" | "failed";
  checked: number;
  found: number;
  startedAt: string;
  finishedAt: string | null;
};

export type FuelRowView = {
  id: string;
  check: FuelCheckName;
  status: "open" | "proposed" | "dismissed" | "cleared";
  driverName: string;
  truckUnit: string | null;
  purchasedOn: string;
  amountCents: number;
  gallonsMilli: number;
  tankGallons: number;
  excessCents: number | null;
  suggestedCents: number | null;
  noSuggestion: NoSuggestionReason | null;
  dismissCategory: string | null;
  purchaseRef: string;
  otherPurchaseRef: string | null;
  loadId: string | null;
  loadNumber: string | null;
  payItemRef: string | null;
  compare: { verdict: string | null; confidence: string | null; category: string | null };
  // The two compared photos, in the order the model saw them (empty when none were compared).
  photoIds: string[];
  sentence: string;
  proposal: ProposalView | null;
};

export type FuelPage = {
  lastRun: FuelRunView | null;
  needYou: number;
  rows: FuelRowView[];
};

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const ROW_LIMIT = 200;

type RunRow = {
  status: FuelRunView["status"];
  checked_count: number;
  found_count: number;
  started_at: string;
  finished_at: string | null;
};

type Row = {
  id: string;
  check_name: FuelCheckName;
  status: FuelRowView["status"];
  first_name: string;
  last_name: string;
  truck_unit: string | null;
  purchased_on: string;
  state: string;
  gallons_milli: number;
  tank_gallons: number;
  paid_with: "company_card" | "driver_own";
  amount_cents: number | string;
  excess_cents: number | string | null;
  suggested_cents: number | string | null;
  no_suggestion: NoSuggestionReason | null;
  dismiss_category: string | null;
  purchase_ref: string;
  other_ref: string | null;
  minutes_apart: number | null;
  load_id: string | null;
  load_number: string | null;
  item_ref: string | null;
  compare_verdict: string | null;
  compare_confidence: string | null;
  compare_category: string | null;
  compare_document_ids: string;
  proposal_id: string | null;
};

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

function idsOf(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function readFuelPage(session: Session, deps: { db?: TenantDb } = {}): Promise<FuelPage> {
  const db = deps.db ?? getDb();
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const runs = await q.query<RunRow>(
      `SELECT status, checked_count, found_count,
              to_char(started_at AT TIME ZONE 'UTC', ${ISO}) AS started_at,
              to_char(finished_at AT TIME ZONE 'UTC', ${ISO}) AS finished_at
         FROM fuel_check_runs ORDER BY started_at DESC, id DESC LIMIT 1`,
    );
    const rows = await q.query<Row>(
      `SELECT f.id, f.check_name, f.status, d.first_name, d.last_name, d.truck_unit,
              CAST(f.purchased_on AS text) AS purchased_on, f.state, f.gallons_milli, f.tank_gallons, f.paid_with,
              f.amount_cents, f.excess_cents, f.suggested_cents, f.no_suggestion, f.dismiss_category,
              p.purchase_ref, o.purchase_ref AS other_ref,
              CASE WHEN o.id IS NULL THEN NULL
                   ELSE CAST(floor(extract(epoch FROM (p.purchased_at - o.purchased_at)) / 60) AS integer) END
                AS minutes_apart,
              f.load_id, l.load_number, i.item_ref,
              f.compare_verdict, f.compare_confidence, f.compare_category,
              CAST(f.compare_document_ids AS text) AS compare_document_ids, f.proposal_id
         FROM fuel_findings f
         JOIN drivers d ON d.tenant_id = f.tenant_id AND d.id = f.driver_id
         JOIN fuel_purchases p ON p.tenant_id = f.tenant_id AND p.id = f.fuel_purchase_id
         LEFT JOIN fuel_purchases o ON o.tenant_id = f.tenant_id AND o.id = f.other_purchase_id
         LEFT JOIN loads l ON l.tenant_id = f.tenant_id AND l.id = f.load_id
         LEFT JOIN pay_items i ON i.tenant_id = f.tenant_id AND i.id = f.pay_item_id
        ORDER BY CASE f.status WHEN 'open' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
                 f.purchased_on DESC, f.finding_key
        LIMIT ${ROW_LIMIT}`,
    );
    const loadIds = [...new Set(rows.map((r) => r.load_id).filter((x): x is string => x !== null))];
    const states = new Map<string, string[]>();
    if (loadIds.length > 0) {
      const miles = await q.query<{ load_id: string; state: string }>(
        `SELECT load_id, state FROM load_state_miles WHERE load_id = ANY(CAST($1 AS uuid[]))`,
        [`{${loadIds.join(",")}}`],
      );
      for (const m of miles) states.set(m.load_id, [...(states.get(m.load_id) ?? []), m.state]);
    }
    const proposals = new Map<string, ProposalView>();
    const linked = rows.map((r) => r.proposal_id).filter((x): x is string => x !== null);
    for (const p of await readProposalViews(q, linked)) proposals.set(p.id, p);
    const open = await q.query<{ n: number | string }>("SELECT count(*) AS n FROM fuel_findings WHERE status = 'open'");

    const run = runs[0];
    return {
      lastRun: run
        ? {
            status: run.status,
            checked: run.checked_count,
            found: run.found_count,
            startedAt: run.started_at,
            finishedAt: run.finished_at,
          }
        : null,
      needYou: Number(open[0]?.n ?? 0),
      rows: rows.map((r): FuelRowView => {
        const loadStates = r.load_id
          ? [...(states.get(r.load_id) ?? [])].sort((a, b) => stateName(a).localeCompare(stateName(b), "en-US"))
          : [];
        const driverName = `${r.first_name} ${r.last_name}`;
        return {
          id: r.id,
          check: r.check_name,
          status: r.status,
          driverName,
          truckUnit: r.truck_unit,
          purchasedOn: r.purchased_on,
          amountCents: Number(r.amount_cents),
          gallonsMilli: r.gallons_milli,
          tankGallons: r.tank_gallons,
          excessCents: num(r.excess_cents),
          suggestedCents: num(r.suggested_cents),
          noSuggestion: r.no_suggestion,
          dismissCategory: r.dismiss_category,
          purchaseRef: r.purchase_ref,
          otherPurchaseRef: r.other_ref,
          loadId: r.load_id,
          loadNumber: r.load_number,
          payItemRef: r.item_ref,
          compare: { verdict: r.compare_verdict, confidence: r.compare_confidence, category: r.compare_category },
          photoIds: idsOf(r.compare_document_ids),
          sentence: fuelSentence({
            check: r.check_name,
            driver: driverName,
            purchasedOn: r.purchased_on,
            state: r.state,
            gallonsMilli: r.gallons_milli,
            tankGallons: r.tank_gallons,
            amountCents: Number(r.amount_cents),
            paidWith: r.paid_with,
            loadNumber: r.load_number,
            loadStates,
            minutesApart: r.minutes_apart,
          }),
          proposal: r.proposal_id ? (proposals.get(r.proposal_id) ?? null) : null,
        };
      }),
    };
  });
}
