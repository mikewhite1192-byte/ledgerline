import { randomUUID } from "node:crypto";
import { LOAD_NUMBER } from "../ratecon/args";
import { SYNTHETIC_LABELS } from "../tms/status";
import type { Queryable } from "../db";
import { PICKUP_WINDOW } from "../loads/paperwork";
import { addDays, daysBetween, isLocalDate, localDateOf, type Instant, type LocalDate } from "../time/local-date";
import { changeAt } from "./clock";
import { applyMockAction, WHO_WORDS, type MockWho } from "./store";

// MOCK-TMS: "New load" in the sample dispatch system (/tms-demo/loads/new, flags.mockTms.newLoad).
// One form writes both sides in one tenant transaction, all or nothing: the sample system's load
// (its two stops, its revenue lines and its first history row, New) and our own planned `loads`
// row with the same number, as the rate confirmation's executor writes one (planned, no empty
// miles, no state miles). The desk then links the two by whole load number on its next read of the
// mirror, as it links every load; nothing in the sync changes. The driver, required, is set on our
// row at birth and assigned there through the store's own action (New to Booked), so both sides
// agree from the start: nothing later copies a driver from the sample system onto our row. Dedupe key: the load number, on both tables. At most maxNewLoads
// unseeded loads a carrier; a demo reset removes them with the rest of the seeded tables' rows.
// No money: our row carries the rate a person typed, and the engine prices it later as any load.

const L = SYNTHETIC_LABELS;
const CUSTOMER_CODE = /^[A-Z0-9-]{2,20}$/;
const DRIVER_ID = /^[A-Za-z0-9._-]{1,40}$/;
const MONEY = /^\d{1,6}(\.\d{1,2})?$/;
const MILES = /^\d{1,4}$/;
// How far from the carrier's today a pickup may be: today or up to the pickup paper window's days
// after (src/lib/loads/paperwork.ts), so a pickup and a delivery completed today both fall in the
// desk's windows and the desk moves the load. And how long a load may run.
export const PICKUP_DAYS_BACK = PICKUP_WINDOW.after;
export const PICKUP_DAYS_AHEAD = 0;
export const MAX_RUN_DAYS = 14;
// The stop windows a new load gets, in the carrier's local time.
const WINDOW_FROM = "T08:00";
const WINDOW_TO = "T16:00";

export type NewLoadStop = { name: string; city: string; state: string; on: LocalDate };

// The places a stop may be, a fixed list: every visitor to a shared demo carrier sees its loads, so
// a place is picked, never typed. The form sends a place's whole label back.
export const NEW_LOAD_PLACES: readonly { name: string; city: string; state: string }[] = [
  { name: "Joliet Yard", city: "Joliet", state: "IL" },
  { name: "Gary Dock", city: "Gary", state: "IN" },
  { name: "Columbus Yard", city: "Columbus", state: "OH" },
  { name: "Memphis Dock", city: "Memphis", state: "TN" },
  { name: "Dallas Yard", city: "Dallas", state: "TX" },
  { name: "Atlanta Dock", city: "Atlanta", state: "GA" },
  { name: "Kansas City Yard", city: "Kansas City", state: "MO" },
  { name: "Denver Dock", city: "Denver", state: "CO" },
];

export const placeLabel = (p: { city: string; state: string }): string => `${p.city}, ${p.state}`;

export type NewLoadInput = {
  loadNumber: string;
  customerCode: string;
  pickup: NewLoadStop;
  delivery: NewLoadStop;
  loadedMiles: number;
  linehaulCents: number;
  fuelSurchargeCents: number;
  driverExternalId: string;
};

export type NewLoadRefusal = "not_found" | "cap" | "exists" | "unknown_customer" | "unknown_driver" | "bad_date";

export type NewLoadResult =
  | { ok: true; externalId: string; reference: string; loadId: string; at: Instant }
  | { ok: false; category: NewLoadRefusal };

// A refusal met after the first write, or a write that reported no row: thrown so the transaction
// rolls both sides back.
export class NewLoadUndone extends Error {
  constructor() {
    super("new load undone");
    this.name = "NewLoadUndone";
  }
}

type FormLike = { get(name: string): unknown };

const field = (form: FormLike, name: string): string | null => {
  const v = form.get(name);
  return typeof v === "string" && v.length <= 120 ? v.trim() : null;
};

// Whole cents from a typed amount ("1850", "1850.5", "$1850.50"), by string, never a float.
export function centsOf(raw: string): number | null {
  const v = raw.startsWith("$") ? raw.slice(1) : raw;
  if (!MONEY.test(v)) return null;
  const [whole, frac = ""] = v.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

function stopOf(form: FormLike, prefix: "pickup" | "delivery"): NewLoadStop | null {
  const label = field(form, `${prefix}Place`);
  const place = NEW_LOAD_PLACES.find((p) => placeLabel(p) === label);
  const on = field(form, `${prefix}On`);
  if (place === undefined || !isLocalDate(on)) return null;
  return { name: place.name, city: place.city, state: place.state, on };
}

// The form as typed, every value checked for shape and each place against the fixed list by its
// whole label; null for anything else. The dates' range against the carrier's today is checked in
// createMockLoad, which reads the zone.
export function parseNewLoad(form: FormLike): NewLoadInput | null {
  const loadNumber = field(form, "loadNumber")?.toUpperCase() ?? null;
  if (loadNumber === null || !LOAD_NUMBER.test(loadNumber)) return null;
  const customerCode = field(form, "customer");
  if (customerCode === null || !CUSTOMER_CODE.test(customerCode)) return null;
  const pickup = stopOf(form, "pickup");
  const delivery = stopOf(form, "delivery");
  if (pickup === null || delivery === null) return null;
  const miles = field(form, "miles");
  if (miles === null || !MILES.test(miles) || Number(miles) < 1) return null;
  const rate = field(form, "rate");
  const linehaulCents = rate === null ? null : centsOf(rate);
  if (linehaulCents === null || linehaulCents < 1) return null;
  const fuel = field(form, "fuel");
  const fuelSurchargeCents = fuel === null || fuel === "" ? 0 : centsOf(fuel);
  if (fuelSurchargeCents === null) return null;
  const driver = field(form, "driver");
  if (driver === null || !DRIVER_ID.test(driver)) return null;
  return {
    loadNumber,
    customerCode,
    pickup,
    delivery,
    loadedMiles: Number(miles),
    linehaulCents,
    fuelSurchargeCents,
    driverExternalId: driver,
  };
}

// The form's fields, for a refusal to hand back what the visitor entered.
export const NEW_LOAD_FIELDS = [
  "loadNumber",
  "customer",
  "pickupPlace",
  "pickupOn",
  "deliveryPlace",
  "deliveryOn",
  "miles",
  "rate",
  "fuel",
  "driver",
] as const;

export type NewLoadDraft = Partial<Record<(typeof NEW_LOAD_FIELDS)[number], string>>;

const placeOk = (v: string) => NEW_LOAD_PLACES.some((p) => placeLabel(p) === v);
const DRAFT_CHECKS: Record<(typeof NEW_LOAD_FIELDS)[number], (v: string) => boolean> = {
  loadNumber: (v) => LOAD_NUMBER.test(v.toUpperCase()),
  customer: (v) => CUSTOMER_CODE.test(v),
  pickupPlace: placeOk,
  pickupOn: isLocalDate,
  deliveryPlace: placeOk,
  deliveryOn: isLocalDate,
  miles: (v) => MILES.test(v),
  rate: (v) => centsOf(v) !== null,
  fuel: (v) => centsOf(v) !== null,
  driver: (v) => DRIVER_ID.test(v),
};

// What the visitor entered, each field kept only when it passes its own shape check, so a refused
// form comes back filled in; anything else is left out and the field falls back to its default.
export function draftOf(form: FormLike): NewLoadDraft {
  const out: NewLoadDraft = {};
  for (const name of NEW_LOAD_FIELDS) {
    const v = field(form, name);
    if (v !== null && v !== "" && DRAFT_CHECKS[name](v)) out[name] = v;
  }
  return out;
}

// A pickup from two days back to the carrier's today, and a delivery on or after it, at most
// fourteen days later.
export function datesFit(pickupOn: LocalDate, deliveryOn: LocalDate, today: LocalDate): boolean {
  if (pickupOn < addDays(today, -PICKUP_DAYS_BACK) || pickupOn > addDays(today, PICKUP_DAYS_AHEAD)) return false;
  return deliveryOn >= pickupOn && daysBetween(pickupOn, deliveryOn) <= MAX_RUN_DAYS;
}

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function one(q: Queryable, sql: string, params: (string | number | null)[]): Promise<void> {
  const n = await q.execute(sql, params);
  // Inside the transaction, so it rolls back: a plain failure, never a maybe-written one.
  if (n !== 1) throw new NewLoadUndone();
}

export async function createMockLoad(
  q: Queryable,
  input: NewLoadInput,
  who: MockWho,
  opts: { nowMs: number; maxNewLoads: number; maxEventsPerLoad: number },
): Promise<NewLoadResult> {
  const fail = (category: NewLoadRefusal): NewLoadResult => ({ ok: false, category });
  // The connection row, locked: two creates at once take turns, so the cap's count holds.
  const conn = await q.query<{ system: string; feed_floor_at: string | null; zone: string }>(
    `SELECT c.system, ${ts("c.feed_floor_at")} AS feed_floor_at, t.timezone AS zone
       FROM tms_connections c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.tenant_id = current_tenant_id() FOR UPDATE OF c`,
  );
  if (conn.length !== 1 || conn[0].system !== "mock") return fail("not_found");
  const { zone, feed_floor_at } = conn[0];
  const today = localDateOf(new Date(opts.nowMs).toISOString(), zone);
  if (!datesFit(input.pickup.on, input.delivery.on, today)) return fail("bad_date");

  const made = await q.query<{ n: number }>(
    "SELECT CAST(count(*) AS integer) AS n FROM mock_tms_loads WHERE tenant_id = current_tenant_id() AND NOT seeded",
  );
  if (Number(made[0]?.n ?? 0) >= opts.maxNewLoads) return fail("cap");
  const taken = await q.query<{ n: number }>(
    `SELECT CAST((SELECT count(*) FROM mock_tms_loads WHERE tenant_id = current_tenant_id() AND reference = $1)
              + (SELECT count(*) FROM loads WHERE tenant_id = current_tenant_id() AND load_number = $1) AS integer) AS n`,
    [input.loadNumber],
  );
  if (Number(taken[0]?.n ?? 0) !== 0) return fail("exists");

  // The customer as both systems know it: the sample system's party by whole code, and our one
  // customer row with that code.
  const party = await q.query<{ name: string }>(
    `SELECT name FROM mock_tms_parties WHERE tenant_id = current_tenant_id() AND kind = 'customer' AND external_id = $1`,
    [input.customerCode],
  );
  const customer = await q.query<{ id: string }>(
    "SELECT CAST(id AS text) AS id FROM customers WHERE tenant_id = current_tenant_id() AND code = $1",
    [input.customerCode],
  );
  if (party.length !== 1 || customer.length !== 1) return fail("unknown_customer");

  // The driver: the sample system's party, and our one driver its id maps to.
  const p = await q.query<{ n: number }>(
    `SELECT CAST(count(*) AS integer) AS n FROM mock_tms_parties
      WHERE tenant_id = current_tenant_id() AND kind = 'driver' AND external_id = $1`,
    [input.driverExternalId],
  );
  const ids = await q.query<{ driver_id: string }>(
    `SELECT CAST(driver_id AS text) AS driver_id FROM driver_identities
      WHERE tenant_id = current_tenant_id() AND system = 'tms' AND external_id = $1`,
    [input.driverExternalId],
  );
  if (Number(p[0]?.n ?? 0) !== 1 || ids.length !== 1) return fail("unknown_driver");
  const driverId = ids[0].driver_id;

  const at = changeAt(opts.nowMs, feed_floor_at, []);
  const loadId = randomUUID();
  const mockId = randomUUID();
  const reference = input.loadNumber;
  const externalId = `mock:${reference}`;
  const { pickup, delivery } = input;

  // Ours first: a number another load took meanwhile writes nothing on either side.
  const inserted = await q.execute(
    `INSERT INTO loads
       (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state, dest_city,
        dest_state, pickup_on, loaded_miles, empty_miles, linehaul_cents, fuel_surcharge_cents)
     VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), 'planned', $5, $6, $7, $8,
             CAST($9 AS date), $10, 0, $11, $12)
     ON CONFLICT DO NOTHING`,
    [
      loadId,
      reference,
      customer[0].id,
      driverId,
      pickup.city,
      pickup.state,
      delivery.city,
      delivery.state,
      pickup.on,
      input.loadedMiles,
      input.linehaulCents,
      input.fuelSurchargeCents,
    ],
  );
  if (inserted !== 1) return fail("exists");

  await one(
    q,
    `INSERT INTO mock_tms_loads (id, tenant_id, external_id, reference, status_label, customer_external_id, customer_name,
       created_at, updated_at, seeded)
     VALUES (CAST($1 AS uuid), current_tenant_id(), $2, $3, $4, $5, $6, CAST($7 AS timestamptz), CAST($7 AS timestamptz), false)`,
    [mockId, externalId, reference, L.new, input.customerCode, party[0].name, at],
  );
  for (const [ordinal, kind, s] of [
    [0, "pickup", pickup],
    [1, "delivery", delivery],
  ] as const) {
    await one(
      q,
      `INSERT INTO mock_tms_stops (id, tenant_id, mock_load_id, ordinal, stop_kind, name, city, state, appt_from_local, appt_to_local)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), $2, $3, $4, $5, $6, $7, $8)`,
      [mockId, ordinal, kind, s.name, s.city, s.state, `${s.on}${WINDOW_FROM}`, `${s.on}${WINDOW_TO}`],
    );
  }
  // The synthetic feed's own line labels, so the mirror reads the revenue the same way.
  const lines: [string, string, string, number][] = [[`${externalId}:line1`, "Linehaul", "Linehaul", input.linehaulCents]];
  if (input.fuelSurchargeCents > 0) lines.push([`${externalId}:line2`, "Fuel Surcharge", "Fuel surcharge", input.fuelSurchargeCents]);
  for (const [lineId, typeLabel, description, cents] of lines) {
    await one(
      q,
      `INSERT INTO mock_tms_lines (id, tenant_id, mock_load_id, external_id, item_group, type_label, description, amount_cents)
       VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), $2, 'revenue', $3, $4, $5)`,
      [mockId, lineId, typeLabel, description, cents],
    );
  }
  await one(
    q,
    `INSERT INTO mock_tms_events (id, tenant_id, mock_load_id, seq, external_id, field, new_value, previous_value, changed_by, at)
     VALUES (gen_random_uuid(), current_tenant_id(), CAST($1 AS uuid), 1, $2, 'status', $3, NULL, $4, CAST($5 AS timestamptz))`,
    [mockId, `${externalId}:e1`, L.new, WHO_WORDS[who], at],
  );

  const assigned = await applyMockAction(q, reference, { kind: "assign_driver", driverExternalId: input.driverExternalId }, who, {
    nowMs: opts.nowMs,
    maxEventsPerLoad: opts.maxEventsPerLoad,
  });
  if (!assigned.ok) throw new NewLoadUndone();
  return { ok: true, externalId, reference, loadId, at };
}

// ---------------------------------------------------------------------------------------------
// Reads for the form and the load page.

export type NewLoadFormView = {
  zone: string;
  today: LocalDate;
  customers: { code: string; name: string }[];
  drivers: { externalId: string; name: string }[];
  // The one open pay week, or null when none (or more than one) is open.
  openWeek: { start: LocalDate; end: LocalDate } | null;
  made: number;
};

// What the form offers: only the parties that resolve to one of our customers or drivers.
export async function readNewLoadForm(q: Queryable, nowMs: number): Promise<NewLoadFormView | null> {
  const conn = await q.query<{ system: string; zone: string }>(
    `SELECT c.system, t.timezone AS zone FROM tms_connections c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.tenant_id = current_tenant_id()`,
  );
  if (conn.length !== 1 || conn[0].system !== "mock") return null;
  const customers = await q.query<{ external_id: string; name: string }>(
    `SELECT p.external_id, p.name FROM mock_tms_parties p
      WHERE p.tenant_id = current_tenant_id() AND p.kind = 'customer'
        AND EXISTS (SELECT 1 FROM customers c WHERE c.tenant_id = p.tenant_id AND c.code = p.external_id)
      ORDER BY p.name, p.external_id`,
  );
  const drivers = await q.query<{ external_id: string; name: string }>(
    `SELECT p.external_id, p.name FROM mock_tms_parties p
      WHERE p.tenant_id = current_tenant_id() AND p.kind = 'driver'
        AND EXISTS (SELECT 1 FROM driver_identities i
                     WHERE i.tenant_id = p.tenant_id AND i.system = 'tms' AND i.external_id = p.external_id)
      ORDER BY p.name, p.external_id`,
  );
  const weeks = await q.query<{ start: string; end: string }>(
    `SELECT to_char(period_start, 'YYYY-MM-DD') AS start, to_char(period_end, 'YYYY-MM-DD') AS "end"
       FROM settlement_periods WHERE tenant_id = current_tenant_id() AND status = 'open'`,
  );
  const made = await q.query<{ n: number }>(
    "SELECT CAST(count(*) AS integer) AS n FROM mock_tms_loads WHERE tenant_id = current_tenant_id() AND NOT seeded",
  );
  const week = weeks.length === 1 && isLocalDate(weeks[0].start) && isLocalDate(weeks[0].end) ? weeks[0] : null;
  return {
    zone: conn[0].zone,
    today: localDateOf(new Date(nowMs).toISOString(), conn[0].zone),
    customers: customers.map((c) => ({ code: c.external_id, name: c.name })),
    drivers: drivers.map((d) => ({ externalId: d.external_id, name: d.name })),
    openWeek: week === null ? null : { start: week.start, end: week.end },
    made: Number(made[0]?.n ?? 0),
  };
}

// Our load with this number, for the sample system's "Open in LedgerLine" link; null when none.
export async function ourLoadIdOf(q: Queryable, reference: string): Promise<string | null> {
  const rows = await q.query<{ id: string }>(
    "SELECT CAST(id AS text) AS id FROM loads WHERE tenant_id = current_tenant_id() AND load_number = $1",
    [reference],
  );
  return rows.length === 1 ? rows[0].id : null;
}
