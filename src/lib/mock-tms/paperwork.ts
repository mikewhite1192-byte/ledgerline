import { flags } from "../../config/flags";
import { AiError, complete } from "../ai";
import type { Session } from "../auth/claims";
import { countVisitTurn } from "../auth/demo-visit";
import { readRole } from "../auth/role";
import { getDb, type Queryable, type TenantDb } from "../db";
import { READ_TIMEOUT_MS, type ReadComplete, type ReadDeps } from "../documents/read";
import {
  FINISH_RESERVE_MS,
  MIN_READ_MS,
  readAgain,
  REQUEST_BUDGET_MS,
  sha256,
  STALLED_MS,
  uploadDocument,
  type ServiceDeps,
} from "../documents/service";
import { findDocumentByHash } from "../documents/store";
import { READ_ATTEMPTS_MAX } from "../documents/types";
import { moveFromDocument, type MoveReason, type MoveTo } from "../loads/movement";
import { PICKUP_WINDOW, POD_WINDOW_DAYS } from "../loads/paperwork";
import { isJudge } from "../roles";
import { instantAt } from "../seed/calendar";
import { localStampText, mmddyyyy, type PdfContent } from "../seed/docs/documents";
import { demoTemplateOf } from "../seed/reset";
import { assertMembership } from "../tenant/context";
import { addDays, daysBetween, localDateOf, type Instant, type LocalDate } from "../time/local-date";
import { localClockOf } from "../tms/clocks";
import { applyMockAction, type MockRefusal } from "./store";

// D-098: the driver's phone on the sample dispatch board. One tap renders the driver's signed paper
// for one load (a bill of lading at pickup, the signed proof of delivery at delivery) and sends it
// through the document pipeline, as the driver app would: the paper is stored, Muse Spark reads it
// (src/lib/ai, the read's own caps; a judge's visit pays it) and code compares the reading to the
// load by its whole load number (src/lib/documents/match.ts). The model only reads. Then, in one
// tenant transaction, code moves the load by the paperwork rules (moveFromDocument, which re-checks
// its own switch) and, only on a move, completes the same stop on the sample board through the
// board's own change (applyMockAction, which refuses unless the carrier is on the sample system).
// Nothing here moves money, writes a real dispatch system or calls the board's webhook.
//
// Fail closed: a read that did not finish, a paper that is not this load's, or a move the rules
// could not make moves nothing on the board. The paper's bytes depend only on the load, the stage
// and the paper's times, so a repeat tap sends the same file, which the pipeline keeps once
// (documents content_hash). A repeat tap never starts a second read while one runs; once that row
// has sat pending past the documents' stalled time (STALLED_MS), the tap takes it again with Read
// again's own claim, READ_ATTEMPTS_MAX reads in all. A tap that cannot start a read costs no turn.

export type PaperStage = "pickup" | "delivery";

export function stageOf(status: string): PaperStage | null {
  if (status === "planned") return "pickup";
  if (status === "in_transit") return "delivery";
  return null;
}

export type PaperLoad = {
  id: string;
  loadNumber: string;
  status: string;
  pickupOn: LocalDate;
  pickupDepartedAt: Instant | null;
  origin: { city: string; state: string };
  destination: { city: string; state: string };
  customer: { name: string; city: string; state: string };
  carrierName: string;
  driverCode: string | null;
  driverFirstName: string | null;
  truckUnit: string | null;
  zone: string;
};

type PaperLoadRow = {
  id: string;
  load_number: string;
  status: string;
  pickup_on: string;
  pickup_departed_at: string | null;
  origin_city: string;
  origin_state: string;
  dest_city: string;
  dest_state: string;
  customer_name: string;
  customer_city: string;
  customer_state: string;
  carrier_name: string;
  driver_code: string | null;
  driver_first_name: string | null;
  truck_unit: string | null;
  zone: string;
};

// LedgerLine's own load with this whole load number in the current tenant, or null.
export async function readPaperLoad(q: Queryable, reference: string): Promise<PaperLoad | null> {
  const rows = await q.query<PaperLoadRow>(
    `SELECT CAST(l.id AS text) AS id, l.load_number, l.status, to_char(l.pickup_on, 'YYYY-MM-DD') AS pickup_on,
            to_char(l.pickup_departed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS pickup_departed_at,
            l.origin_city, l.origin_state, l.dest_city, l.dest_state,
            c.name AS customer_name, c.city AS customer_city, c.state AS customer_state,
            t.name AS carrier_name, t.timezone AS zone,
            d.code AS driver_code, d.first_name AS driver_first_name, d.truck_unit
       FROM loads l
       JOIN customers c ON c.tenant_id = l.tenant_id AND c.id = l.customer_id
       JOIN tenants t ON t.id = l.tenant_id
       LEFT JOIN drivers d ON d.tenant_id = l.tenant_id AND d.id = l.driver_id
      WHERE l.tenant_id = current_tenant_id() AND l.load_number = $1`,
    [reference],
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  return {
    id: r.id,
    loadNumber: r.load_number,
    status: r.status,
    pickupOn: r.pickup_on,
    pickupDepartedAt: r.pickup_departed_at,
    origin: { city: r.origin_city, state: r.origin_state },
    destination: { city: r.dest_city, state: r.dest_state },
    customer: { name: r.customer_name, city: r.customer_city, state: r.customer_state },
    carrierName: r.carrier_name,
    driverCode: r.driver_code,
    driverFirstName: r.driver_first_name,
    truckUnit: r.truck_unit,
    zone: r.zone,
  };
}

// Our load's status for the board's load page, or null when there is no one load with that number.
export async function ourPaperStatusOf(q: Queryable, reference: string): Promise<string | null> {
  const rows = await q.query<{ status: string }>(
    "SELECT status FROM loads WHERE tenant_id = current_tenant_id() AND load_number = $1",
    [reference],
  );
  return rows.length === 1 ? rows[0].status : null;
}

export type PaperTimes = { date: LocalDate; arrivedAt: Instant; departedAt: Instant };

// not_due: the paper could not count yet (a pickup more than a day ahead, a delivery before the
// pickup date). too_soon: no room for the stop's times before now (just after midnight, or minutes
// after the pickup left).
export type PaperDates = { ok: true; times: PaperTimes } | { ok: false; reason: "not_due" | "too_soon" };

const MINUTE_MS = 60_000;
const ceilMinute = (ms: number) => Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
const iso = (ms: number) => new Date(ms).toISOString();

// The stop's fixed times on the paper, local: pickup 7:40 to 8:05 AM, delivery 1:50 to 2:14 PM.
const STOP_CLOCK: Record<PaperStage, { arrived: [number, number]; departed: [number, number] }> = {
  pickup: { arrived: [7, 40], departed: [8, 5] },
  delivery: { arrived: [13, 50], departed: [14, 14] },
};

// A paper dated today whose fixed clock is still ahead: 12:01 to 12:19 AM that day. Fixed, never
// the tap's minute, so every tap before the fixed clock renders the same bytes.
const EARLY_CLOCK = { arrived: [0, 1], departed: [0, 19] } as const;

// The paper's date and its stop's times. Pure. The date is the last day the paperwork rules allow
// (src/lib/loads/paperwork.ts), never after today: a pickup paper on min(today, pickup + 2 days),
// a delivery on min(today, pickup + 14 days). The times are the stop's fixed clock in the carrier's
// zone; a paper dated today whose fixed time is still ahead uses the early clock instead (12:01 to
// 12:19 AM). A delivery always starts after the pickup left. The times depend only on the date,
// the stage, the stored pickup departure and whether the fixed clock has passed, never on the tap's
// minute, so a repeat tap renders the same paper and the documents content_hash keeps it once (the
// paper changes at most once a day, when the fixed clock passes).
export function paperDatesFor(
  stage: PaperStage,
  load: { pickupOn: LocalDate; pickupDepartedAt: Instant | null },
  nowMs: number,
  zone: string,
): PaperDates {
  const today = localDateOf(iso(nowMs), zone);
  const last = addDays(load.pickupOn, stage === "pickup" ? PICKUP_WINDOW.after : POD_WINDOW_DAYS);
  const date = last < today ? last : today;
  const fromPickup = daysBetween(load.pickupOn, date);
  if (stage === "pickup" ? fromPickup < -PICKUP_WINDOW.before : fromPickup < 0) return { ok: false, reason: "not_due" };

  const clock = STOP_CLOCK[stage];
  let arrived = Date.parse(instantAt(date, clock.arrived[0], clock.arrived[1], zone));
  let departed = Date.parse(instantAt(date, clock.departed[0], clock.departed[1], zone));
  if (departed > nowMs) {
    arrived = Date.parse(instantAt(date, EARLY_CLOCK.arrived[0], EARLY_CLOCK.arrived[1], zone));
    departed = Date.parse(instantAt(date, EARLY_CLOCK.departed[0], EARLY_CLOCK.departed[1], zone));
  }
  if (stage === "delivery" && load.pickupDepartedAt !== null) {
    const left = Date.parse(load.pickupDepartedAt);
    if (!Number.isFinite(left)) return { ok: false, reason: "too_soon" };
    if (arrived <= left) arrived = ceilMinute(left + MINUTE_MS);
    if (departed < arrived) departed = arrived;
  }
  if (departed > nowMs || localDateOf(iso(arrived), zone) !== date || localDateOf(iso(departed), zone) !== date) {
    return { ok: false, reason: "too_soon" };
  }
  return { ok: true, times: { date, arrivedAt: iso(arrived), departedAt: iso(departed) } };
}

const place = (p: { city: string; state: string }) => `${p.city}, ${p.state}`;

// The paper, in the layout the seeded bills of lading use, so the read sees a familiar page. Both
// stages print as a bill of lading (the signed copy at delivery is the proof of delivery), with
// one date and only the stage's own stop, so the paperwork rules count it as that stage's paper.
export function paperContentFor(load: PaperLoad, stage: PaperStage, times: PaperTimes): PdfContent {
  const pickup = stage === "pickup";
  return {
    title: "Bill of Lading",
    fields: [
      { label: "Load", value: load.loadNumber },
      { label: "Shipper", value: place(load.origin) },
      { label: "Consignee", value: place(load.destination) },
      { label: "Bill to", value: `${load.customer.name}, ${place(load.customer)}` },
      { label: "Carrier", value: load.carrierName },
      ...(load.truckUnit === null ? [] : [{ label: "Truck", value: load.truckUnit }]),
      ...(load.driverCode === null ? [] : [{ label: "Driver", value: load.driverCode }]),
      { label: pickup ? "Pickup date" : "Delivery date", value: mmddyyyy(times.date) },
      { label: "Commodity", value: "General freight" },
    ],
    charges: [],
    stops: [
      { label: pickup ? "Pickup arrived" : "Delivery arrived", value: localStampText(times.arrivedAt, load.zone) },
      { label: pickup ? "Pickup departed" : "Delivery departed", value: localStampText(times.departedAt, load.zone) },
    ],
    signatures: pickup ? ["Shipper signature", "Driver signature"] : ["Driver signature", "Received by (consignee)"],
  };
}

export const paperFilename = (reference: string, stage: PaperStage) => `driver-${reference}-${stage}.pdf`;

// Rendered only when a tap gets this far: the PDF library loads on first use.
async function renderPaper(load: PaperLoad, stage: PaperStage, times: PaperTimes): Promise<Uint8Array> {
  const { renderPdfContent } = await import("../seed/docs/pdf");
  const bytes = await renderPdfContent(paperContentFor(load, stage, times), { title: `Bill of Lading ${load.loadNumber} (SAMPLE)` });
  return new Uint8Array(bytes);
}

export type BoardResult = "moved" | "off" | MockRefusal;

// Inside the move's transaction, only after LedgerLine moved the load: the paper's stop on the
// sample board, with the paper's times. Both switches are re-read here. A refusal is a known category and
// leaves our move standing; a thrown error rolls both back.
export async function mirrorMoveToBoard(
  q: Queryable,
  reference: string,
  stage: PaperStage,
  times: PaperTimes,
  zone: string,
  nowMs: number,
): Promise<BoardResult> {
  if (flags.driverPaperwork.enabled !== true || flags.mockTms.enabled !== true) return "off";
  const out = await applyMockAction(
    q,
    reference,
    {
      kind: stage === "pickup" ? "complete_pickup" : "complete_delivery",
      arrivedLocal: localClockOf(times.arrivedAt, zone),
      departedLocal: localClockOf(times.departedAt, zone),
    },
    "coworker",
    { nowMs, maxEventsPerLoad: flags.mockTms.maxEventsPerLoad },
  );
  return out.ok ? "moved" : out.category;
}

export type PaperworkRefusal =
  | "disabled"
  | "not_started"
  | "not_demo"
  | "not_found"
  | "wrong_stage"
  | "not_due"
  | "too_soon"
  | "cap"
  | "visit_ended"
  | "visit_used"
  | "limit"
  | "not_read"
  | "not_matched"
  | "moves_off"
  | "not_moved";

// Fixed parts only; the page builds the sentence. Never a reading's or the server's own words.
export type PaperworkResult =
  | {
      kind: "moved";
      stage: PaperStage;
      loadNumber: string;
      driverFirstName: string | null;
      to: MoveTo;
      // The paper's departure, as the carrier's local clock (YYYY-MM-DDTHH:mm).
      atLocal: string;
      board: BoardResult;
    }
  | { kind: "card"; loadNumber: string; reason: MoveReason }
  | { kind: "already"; loadNumber: string }
  | { kind: "refused"; category: PaperworkRefusal };

export type PaperworkDeps = {
  db?: TenantDb;
  now?: () => Date;
  read?: ReadDeps;
  // A monotonic clock for the request's time budget.
  steady?: () => number;
};

// The board's move and the finish after the read share what is left of the request budget.
const MOVE_RESERVE_MS = 1_500;

const refused = (category: PaperworkRefusal): PaperworkResult => ({ kind: "refused", category });

function tx<T>(db: TenantDb, session: Session, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

type Ready = { ok: true; load: PaperLoad; times: PaperTimes; judge: boolean } | { ok: false; result: PaperworkResult };

// The checks before the paper is rendered, cheapest first, in one transaction. Nothing is counted
// here: the visit's turn waits for charge, after the render.
async function ready(q: Queryable, session: Session, reference: string, stage: PaperStage, now: Date): Promise<Ready> {
  const no = (category: PaperworkRefusal): Ready => ({ ok: false, result: refused(category) });
  const role = await readRole(q, session);
  if (!(await demoTemplateOf(q))) return no("not_demo");
  const load = await readPaperLoad(q, reference);
  if (load === null) return no("not_found");
  const today = localDateOf(now.toISOString(), load.zone);
  if (today < flags.driverPaperwork.startDate) return no("not_started");
  if (stageOf(load.status) !== stage) return no("wrong_stage");
  const dates = paperDatesFor(stage, load, now.getTime(), load.zone);
  if (!dates.ok) return no(dates.reason);
  const sent = await q.query<{ n: number }>(
    `SELECT CAST(count(*) AS integer) AS n FROM documents
      WHERE tenant_id = current_tenant_id() AND filename LIKE 'driver-%'
        AND CAST(created_at AT TIME ZONE $1 AS date) = CAST($2 AS date)`,
    [load.zone, today],
  );
  const n = Number(sent[0]?.n);
  // Unknown is not zero.
  if (!Number.isSafeInteger(n) || n >= flags.driverPaperwork.perDay) return no("cap");
  const judge = isJudge(role);
  if (judge && (session.demoSessionId == null || !flags.judgeAccess.enabled)) return no("visit_ended");
  return { ok: true, load, times: dates.times, judge };
}

type Charge = { ok: true } | { ok: false; result: PaperworkResult };

// After the render, in its own transaction: whether this tap can start a read, and only then the
// visit's turn, so a refused tap spends nothing. A row already held for these bytes and still
// pending is another tap's read still running (not stalled yet), one with no reads left, or a
// stalled one this tap reads again; one that ended unread can never be read again. With too little
// of the request left for a read (MIN_READ_MS), none starts. A paper already read starts no read
// and goes on to its move, which costs the turn.
async function charge(
  q: Queryable,
  session: Session,
  judge: boolean,
  contentHash: string,
  now: Date,
  readLeftMs: number,
): Promise<Charge> {
  const no = (category: PaperworkRefusal): Charge => ({ ok: false, result: refused(category) });
  const held = await findDocumentByHash(q, contentHash);
  const pending = held !== null && held.read_status === "pending";
  if (held !== null && !pending && held.read_status !== "read") return no("not_read");
  if (pending) {
    const stalled = new Date(held.updated_at).getTime() < now.getTime() - STALLED_MS;
    if (!stalled || !(Number(held.read_attempts) < READ_ATTEMPTS_MAX) || !held.filename.startsWith("driver-")) return no("not_read");
  }
  // Unknown is not zero: a clock that gave no number starts no read.
  if ((held === null || pending) && !(readLeftMs >= MIN_READ_MS)) return no("not_read");
  if (judge) {
    const visitId = session.demoSessionId ?? null;
    if (visitId === null || !flags.judgeAccess.enabled) return no("visit_ended");
    const gate = await countVisitTurn(q, {
      visitId,
      sub: session.sub,
      turnsPerSession: flags.judgeAccess.turnsPerSession,
      at: now.toISOString(),
    });
    if (gate !== "ok") return no(gate);
  }
  return { ok: true };
}

// One tap. Throws a database error as it came (the action names it as a category, and an unknown
// commit says the move may have gone through).
export async function sendDriverPaperwork(
  session: Session,
  input: { reference: string; stage: PaperStage },
  deps: PaperworkDeps = {},
): Promise<PaperworkResult> {
  if (flags.driverPaperwork.enabled !== true || flags.mockTms.enabled !== true) return refused("disabled");
  const db = deps.db ?? getDb();
  const clock = deps.now ?? (() => new Date());
  const steady = deps.steady ?? (() => performance.now());
  const started = steady();

  const first = await tx(db, session, (q) => ready(q, session, input.reference, input.stage, clock()));
  if (!first.ok) return first.result;
  const { load, times } = first;

  const bytes = await renderPaper(load, input.stage, times);
  // What the request has left for a read, keeping room for the finish and the move after it.
  const readLeft = () => REQUEST_BUDGET_MS - FINISH_RESERVE_MS - MOVE_RESERVE_MS - Math.max(0, steady() - started);
  const second = await tx(db, session, (q) => charge(q, session, first.judge, sha256(bytes), clock(), readLeft()));
  if (!second.ok) return second.result;

  const call: ReadComplete = deps.read?.complete ?? ((t, r, s) => complete(t, r, s, deps.read?.ai ?? {}));
  const read: ReadDeps = {
    complete: async (t, r, s) => {
      const left = readLeft();
      // Too little left: no model call and no spend, the outcome a timeout would have. The row
      // stays pending for a later tap.
      if (!(left >= MIN_READ_MS)) throw new AiError("timeout");
      const timeoutMs = Math.floor(Math.min(r.timeoutMs ?? READ_TIMEOUT_MS, left));
      return call(t, { ...r, timeoutMs }, s);
    },
  };
  const service: ServiceDeps = { db, now: clock, read, steady };
  const upload = await uploadDocument(
    session,
    { name: paperFilename(load.loadNumber, input.stage), type: "application/pdf", bytes },
    service,
  );
  if (!upload.ok) return refused(upload.error === "disabled" ? "disabled" : upload.error === "limit" ? "limit" : "not_read");
  let view = upload.view;
  if (upload.duplicate && view.readStatus === "pending") {
    // This code's own paper, stalled (charge checked both; checked again on the row as it is now).
    // Read again's claim lets one of two taps start the read; the other ends not_read.
    if (!view.stalled || !view.filename.startsWith("driver-")) return refused("not_read");
    const again = await readAgain(session, view.id, service);
    if (!again.ok) return refused("not_read");
    view = again.view;
  }
  if (view.readStatus !== "read") return refused("not_read");
  if (view.kind !== "bill_of_lading" || view.match === null || view.match.found !== true || view.match.loadId !== load.id) {
    return refused("not_matched");
  }

  return tx(db, session, async (q): Promise<PaperworkResult> => {
    const now = clock();
    const out = await moveFromDocument(q, session, view.id, now);
    if (out.kind === "moved") {
      const board = await mirrorMoveToBoard(q, load.loadNumber, input.stage, times, load.zone, now.getTime());
      return {
        kind: "moved",
        stage: input.stage,
        loadNumber: load.loadNumber,
        driverFirstName: load.driverFirstName,
        to: out.to,
        atLocal: localClockOf(times.departedAt, load.zone),
        board,
      };
    }
    if (out.kind === "already") return { kind: "already", loadNumber: load.loadNumber };
    if (out.kind === "card") return { kind: "card", loadNumber: load.loadNumber, reason: out.reason };
    if (out.kind === "nothing" && out.category === "switched_off") return refused("moves_off");
    return refused("not_moved");
  });
}
