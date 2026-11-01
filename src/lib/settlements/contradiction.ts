import type { Queryable } from "../db";
import type { PayLine, SourceRef } from "../rules-engine";
import { isUuid } from "../uuid";
import { rowKey, type SourceProblem } from "./reconcile";

// The contradiction check (design-s8, 0084): code, never the model, compares a paystub's lines
// with the records they claim to match, at entry and again in the pre-pay recheck before every
// approval. Two rules, each a contradicting_line when it fails:
//   1. A line a person typed (entered_by set) must cite one fuel purchase, or one lumper the driver
//      paid, of this driver that exists now, and its amount must equal that record's amount to the
//      cent.
//   2. An insurance line's days must be the distinct dates of the day rows it cites, as they stand
//      now, and its amount must be those days times its per-day rate. The engine counts day rows,
//      so the only honest way to raise the days is to add dated day rows.
// Unknown is not zero: a record the read did not return fails the check.

export const NAMED_TABLES = ["fuel_purchases", "load_accessorials"] as const;
export type NamedTable = (typeof NAMED_TABLES)[number];
export type NamedRef = { table: NamedTable; id: string };

// The same form as 0084's settlement_lines_source_ref_form check: the whole value, the table from
// the two names, a canonical lower-case uuid. No substring match and no case folding.
const SOURCE_REF =
  /^(fuel_purchases|load_accessorials):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function parseSourceRef(value: unknown): NamedRef | null {
  if (typeof value !== "string") return null;
  const m = SOURCE_REF.exec(value);
  if (!m) return null;
  return { table: m[1] as NamedTable, id: m[2] };
}

export const sourceRefOf = (ref: NamedRef): string => `${ref.table}:${ref.id}`;

// What the records say now, keyed `${table}:${id}` (rowKey). A key with null, or no key at all,
// means the read returned no row.
export type SourceFacts = {
  // fuel_purchases and load_accessorials: the record's amount in cents.
  amounts: ReadonlyMap<string, number | null>;
  // driver_days: the row's date (YYYY-MM-DD).
  days: ReadonlyMap<string, string | null>;
};

type ContradictionLine = Pick<PayLine, "kind" | "amountCents" | "sources" | "meta" | "enteredBy" | "sourceRef">;

export const isNamed = (l: ContradictionLine) =>
  (l.enteredBy !== undefined && l.enteredBy !== null) || (l.sourceRef !== undefined && l.sourceRef !== null);

const uuidList = (ids: readonly string[]): string => `{${ids.join(",")}}`;

// The facts the check needs, read under the caller's tenant transaction and row security, bound
// to the paystub's driver: a record of another driver, another carrier or one that is gone reads
// as missing, and so does a load accessorial the driver did not pay (the entry's own rule). One
// query per table, ids whole.
export async function readSourceFacts(
  q: Queryable,
  lines: readonly ContradictionLine[],
  driverId: string,
): Promise<SourceFacts> {
  const amounts = new Map<string, number | null>();
  const days = new Map<string, string | null>();
  const wanted: Record<NamedTable, string[]> = { fuel_purchases: [], load_accessorials: [] };
  const dayIds: string[] = [];
  for (const l of lines) {
    if (isNamed(l)) {
      const ref = parseSourceRef(l.sourceRef);
      if (ref) wanted[ref.table].push(ref.id);
    }
    if (l.kind === "insurance") {
      for (const s of l.sources) if (s.table === "driver_days" && isUuid(s.id)) dayIds.push(s.id.toLowerCase());
    }
  }
  const put = (table: string, rows: { id: string; amount_cents: number | string }[]) => {
    for (const r of rows) {
      const n = Number(r.amount_cents);
      amounts.set(rowKey({ table: table as SourceRef["table"], id: r.id }), Number.isSafeInteger(n) ? n : null);
    }
  };
  if (!isUuid(driverId)) return { amounts, days };
  if (wanted.fuel_purchases.length > 0) {
    put(
      "fuel_purchases",
      await q.query<{ id: string; amount_cents: number | string }>(
        `SELECT CAST(id AS text) AS id, amount_cents FROM fuel_purchases
          WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)
            AND id = ANY(CAST($2 AS uuid[]))`,
        [driverId, uuidList([...new Set(wanted.fuel_purchases)])],
      ),
    );
  }
  if (wanted.load_accessorials.length > 0) {
    put(
      "load_accessorials",
      await q.query<{ id: string; amount_cents: number | string }>(
        `SELECT CAST(a.id AS text) AS id, a.amount_cents FROM load_accessorials a
           JOIN loads l ON l.tenant_id = a.tenant_id AND l.id = a.load_id
          WHERE a.tenant_id = current_tenant_id() AND l.driver_id = CAST($1 AS uuid)
            AND a.id = ANY(CAST($2 AS uuid[])) AND a.paid_by_driver`,
        [driverId, uuidList([...new Set(wanted.load_accessorials)])],
      ),
    );
  }
  if (dayIds.length > 0) {
    const rows = await q.query<{ id: string; day: string }>(
      `SELECT CAST(id AS text) AS id, CAST(day AS text) AS day FROM driver_days
        WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)
          AND id = ANY(CAST($2 AS uuid[]))`,
      [driverId, uuidList([...new Set(dayIds)])],
    );
    for (const r of rows) days.set(rowKey({ table: "driver_days", id: r.id }), r.day);
  }
  return { amounts, days };
}

const safeCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

// One contradicting_line per line that fails a rule, in line order. Pure: no reads, no clock. The
// problem cites the record a typed line names, or an insurance line's first day row (the
// settlement when it has none).
export function findContradictions(
  lines: readonly ContradictionLine[],
  facts: SourceFacts,
  settlementId: string,
): SourceProblem[] {
  const problems: SourceProblem[] = [];
  const settlement: SourceRef = { table: "settlements", id: settlementId };
  const add = (source: SourceRef) =>
    problems.push({ category: "contradicting_line", source: { table: source.table, id: source.id } });
  for (const l of lines) {
    if (isNamed(l)) {
      const ref = parseSourceRef(l.sourceRef);
      const hasPerson = typeof l.enteredBy === "string" && l.enteredBy.length > 0;
      if (!ref || !hasPerson) {
        add(l.sources[0] ?? settlement);
        continue;
      }
      const amount = facts.amounts.get(rowKey(ref)) ?? null;
      if (amount === null || Math.abs(l.amountCents) !== amount) add(ref);
      continue;
    }
    if (l.kind !== "insurance") continue;
    const first = l.sources[0] ?? settlement;
    const days = safeCount(l.meta?.days);
    const perDay = safeCount(l.meta?.perDayCents);
    if (days === null || perDay === null) {
      add(first);
      continue;
    }
    // Every cited record must be a day row that exists now; its date is what counts.
    const dates = l.sources.map((s) => (s.table === "driver_days" ? (facts.days.get(rowKey(s)) ?? null) : null));
    const amount = days * perDay;
    if (
      dates.some((d) => d === null) ||
      new Set(dates).size !== days ||
      !Number.isSafeInteger(amount) ||
      Math.abs(l.amountCents) !== amount
    ) {
      add(first);
    }
  }
  return problems;
}
