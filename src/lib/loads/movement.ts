import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { GatewayRef } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import { requireStaff } from "../auth/role";
import type { Queryable, TenantDb } from "../db";
import { parseRead } from "../documents/schema";
import type { ReadStatus } from "../documents/types";
import { finalizeInvoiceOn, proposeInvoiceOnFinalize } from "../invoices/finalize";
import { persistEngineProposal } from "../proposals/engine";
import { instantAt } from "../seed/calendar";
import { assertMembership } from "../tenant/context";
import { isLocalDate, localDateOf, type Instant, type LocalDate } from "../time/local-date";
import { resolve } from "../tms/clocks";
import { codeOf, isWithdrawn, moveOf, readLabelMap } from "../tms/status";
import { isUuid } from "../uuid";
import { directionOf, namesWhole } from "./message";
import {
  paperDateOf,
  paperworkOf,
  pickupWindowHolds,
  podWindowHolds,
  stopTimesOf,
  whyNotCounted,
  type PaperDocument,
  type PaperLoad,
} from "./paperwork";

// LOAD-MOVEMENT (D-056): the one writer of a load's planned -> in_transit and in_transit ->
// delivered moves. Code decides every move from stored facts: the paperwork the documents reader
// already read and the comparison already matched (src/lib/loads/paperwork.ts), a driver's message
// that names the whole load number (src/lib/loads/message.ts), or a person's press. No model writes
// a status here and nothing here moves money or sends anything.
//
// Each move is one status-guarded UPDATE on the locked load and exactly one load_events row, in the
// caller's tenant transaction, honoring every CHECK of 0004: delivered needs a driver and a
// delivered_on on or after pickup_on, delivered_on and delivered_at come together, and stop times
// come in pairs, departed never before arrived. Stop times are written only when a paper's stops
// claim gives both (0004: NULL means not known yet, never zero dwell). delivered_at is the read
// delivery departure when it falls on the POD's date, else that date at 17:00 in the carrier's
// named zone.
//
// Anything code cannot decide (no whole load number, more than one load, a different driver, a
// date out of the window, a status that is not the one before the move) writes no status and makes
// one load_move card (no money, amount 0) with a plain reason category for a person to tap.

// tms (0075): a status event mirrored from the dispatch system (src/lib/tms/sync.ts).
export type MoveSource = "driver_photo" | "driver_text" | "driver_voice" | "staff" | "demo_feed" | "tms";
export type MoveTo = "in_transit" | "delivered";
export type EvidenceTable = "documents" | "inbound_messages" | "voice_notes" | "tms_status_events";
export type Evidence = { table: EvidenceTable; id: string };

// Why a move was not made, as a category (never a reading's or a message's own words).
export type MoveReason =
  | "no_load_number"
  | "ambiguous_load"
  | "wrong_driver"
  | "unclear_update"
  | "wrong_status"
  | "date_out_of_window"
  | "no_driver"
  | "no_pickup_paper"
  | "field_differs"
  | "no_date"
  | "low_confidence"
  | "stop_unclear"
  // The dispatch system withdrew a load we still run (cancelled, expired or archived there).
  | "tms_withdrawn"
  // A load we still run was deleted in the dispatch system.
  | "tms_gone"
  // The dispatch system's two clocks for the move's time are more than a day apart.
  | "tms_time_unclear";

export type MoveOutcome =
  | { kind: "moved"; loadId: string; to: MoveTo; events: string[] }
  | { kind: "already"; loadId: string }
  // Nothing to do and nothing for a person: switched off, before the start date, not a load paper.
  | { kind: "nothing"; category: string }
  | { kind: "card"; reason: MoveReason; proposalId: string; loadId: string | null }
  // TMS-MIRROR (S3): a finalized dispatch event drafted the load's invoice card.
  | { kind: "proposed"; proposalId: string; loadId: string }
  // TMS-MIRROR (S3): not yet: the finalize waits for the mirror's recheck; the desk carries it to
  // a later wake.
  | { kind: "waiting"; category: string };

type StopTimes = { arrivedAt: Instant; departedAt: Instant } | null;

type Step =
  | { to: "in_transit"; at: Instant; times: StopTimes }
  | { to: "delivered"; at: Instant; deliveredOn: LocalDate; deliveredAt: Instant; times: StopTimes };

type LockedLoad = {
  id: string;
  load_number: string;
  status: string;
  driver_id: string | null;
  pickup_on: LocalDate;
  linehaul_cents: number | null;
};

const ts = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const LOAD_COLUMNS = `CAST(id AS text) AS id, load_number, status, CAST(driver_id AS text) AS driver_id,
       to_char(pickup_on, 'YYYY-MM-DD') AS pickup_on, CAST(linehaul_cents AS integer) AS linehaul_cents`;

// Whether the automatic paths may move a load on evidence dated `day` (the carrier's local date).
export function automaticOn(day: LocalDate): boolean {
  const s = flags.loadMovement;
  return s.enabled === true && isLocalDate(s.startDate) && day >= s.startDate;
}

async function zoneOf(q: Queryable): Promise<string> {
  const rows = await q.query<{ timezone: unknown }>("SELECT timezone FROM tenants WHERE id = current_tenant_id()");
  if (rows.length !== 1 || typeof rows[0].timezone !== "string" || rows[0].timezone === "") {
    throw new Error("tenant zone unknown");
  }
  return rows[0].timezone;
}

async function lockLoad(q: Queryable, loadId: string): Promise<LockedLoad | null> {
  const rows = await q.query<LockedLoad>(
    `SELECT ${LOAD_COLUMNS} FROM loads
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [loadId],
  );
  return rows[0] ?? null;
}

const paperLoad = (l: LockedLoad): PaperLoad => ({ id: l.id, pickup_on: l.pickup_on, linehaul_cents: l.linehaul_cents });

// One move: the status-guarded UPDATE, then its one load_events row. The load is locked and its
// status checked by the caller, so a guard that matches no row means the load changed under the
// lock, which cannot happen: it throws and the whole transaction rolls back (fail closed).
async function writeStep(
  q: Queryable,
  load: LockedLoad,
  step: Step,
  source: MoveSource,
  evidence: Evidence | null,
): Promise<string> {
  const changed =
    step.to === "in_transit"
      ? await q.execute(
          `UPDATE loads SET status = 'in_transit',
                  pickup_arrived_at = COALESCE(pickup_arrived_at, CAST($2 AS timestamptz)),
                  pickup_departed_at = COALESCE(pickup_departed_at, CAST($3 AS timestamptz))
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'planned'`,
          [load.id, step.times?.arrivedAt ?? null, step.times?.departedAt ?? null],
        )
      : await q.execute(
          `UPDATE loads SET status = 'delivered',
                  delivered_on = CAST($2 AS date), delivered_at = CAST($3 AS timestamptz),
                  delivery_arrived_at = COALESCE(delivery_arrived_at, CAST($4 AS timestamptz)),
                  delivery_departed_at = COALESCE(delivery_departed_at, CAST($5 AS timestamptz))
            WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'in_transit'
              AND driver_id IS NOT NULL AND pickup_on <= CAST($2 AS date)`,
          [load.id, step.deliveredOn, step.deliveredAt, step.times?.arrivedAt ?? null, step.times?.departedAt ?? null],
        );
  if (changed !== 1) throw new Error("load did not move under its lock");
  const id = randomUUID();
  await q.execute(
    `INSERT INTO load_events (id, tenant_id, load_id, from_status, to_status, source, evidence_table, evidence_id, at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, $6, CAST($7 AS uuid),
             CAST($8 AS timestamptz))`,
    [
      id,
      load.id,
      step.to === "in_transit" ? "planned" : "in_transit",
      step.to,
      source,
      evidence?.table ?? null,
      evidence?.id ?? null,
      step.to === "delivered" ? step.deliveredAt : step.at,
    ],
  );
  load.status = step.to;
  return id;
}

// The delivered_at for a delivery on `day`: the read departure when it is on that day, else the
// carrier's 17:00 that day.
function deliveredAtOf(day: LocalDate, times: StopTimes, zone: string): Instant {
  if (times && localDateOf(times.departedAt, zone) === day) return times.departedAt;
  return instantAt(day, 17, 0, zone);
}

type CardInput = {
  reason: MoveReason;
  subject: { table: "loads" | "drivers"; id: string };
  loadId: string | null;
  toStatus: MoveTo | null;
  deliveredOn?: LocalDate | null;
  evidence: Evidence | null;
  inputId?: string | null;
};

async function card(q: Queryable, session: Session, now: Date, c: CardInput): Promise<MoveOutcome> {
  const sources: GatewayRef[] = [{ table: c.subject.table, id: c.subject.id }];
  if (c.loadId && c.subject.table !== "loads") sources.push({ table: "loads", id: c.loadId });
  if (c.inputId && isUuid(c.inputId)) sources.push({ table: "untrusted_inputs", id: c.inputId });
  const r = await persistEngineProposal(
    q,
    {
      kind: "load_move",
      subjectTable: c.subject.table,
      subjectId: c.subject.id,
      amountCents: 0,
      args: {
        loadId: c.loadId,
        toStatus: c.toStatus,
        deliveredOn: c.deliveredOn ?? null,
        reason: c.reason,
        evidenceTable: c.evidence?.table ?? null,
        evidenceId: c.evidence?.id ?? null,
      },
      exceptions: [c.reason],
      reasons: [c.reason],
      sources,
      operatorVerdict: "load_move_undecided",
    },
    session,
    now,
  );
  return { kind: "card", reason: c.reason, proposalId: r.proposalId, loadId: c.loadId };
}

// ---------------------------------------------------------------------------------------------
// The paperwork path: a read document matched to a load.

type DocRow = {
  id: string;
  read_status: string;
  document_kind: string | null;
  reading: string | null;
  match: string;
  untrusted_input_id: string | null;
  created_at: string;
};

const DOC_COLUMNS = `CAST(id AS text) AS id, read_status, document_kind, CAST(reading AS text) AS reading,
       CAST(match AS text) AS match, CAST(untrusted_input_id AS text) AS untrusted_input_id,
       ${ts("created_at")} AS created_at`;

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toPaper(row: DocRow): PaperDocument {
  return {
    id: row.id,
    readStatus: row.read_status as ReadStatus,
    kind: row.document_kind,
    read: row.reading === null ? null : parseRead(row.reading),
    match: parseJson(row.match) ?? {},
    createdAt: row.created_at,
  };
}

function matchedLoadId(match: unknown): string | null {
  if (typeof match !== "object" || match === null) return null;
  const m = match as Record<string, unknown>;
  if (m.found !== true || m.table !== "loads" || typeof m.loadId !== "string" || !isUuid(m.loadId)) return null;
  return m.loadId;
}

// The load's read papers (bills of lading and rate confirmations matched to it), only those read
// in from the start date on (the carrier's local midnight): an older paper is never the pickup
// paper or the POD. The caller checked the switch, so the start date is a local date.
async function papersOf(q: Queryable, loadId: string, zone: string): Promise<DocRow[]> {
  return q.query<DocRow>(
    `SELECT ${DOC_COLUMNS} FROM documents
      WHERE tenant_id = current_tenant_id() AND read_status = 'read'
        AND document_kind IN ('bill_of_lading', 'rate_confirmation') AND match->>'loadId' = $1
        AND created_at >= CAST($2 AS timestamptz)
      ORDER BY created_at, id`,
    [loadId, instantAt(flags.loadMovement.startDate, 0, 0, zone)],
  );
}

type PodStep =
  | { kind: "moved"; event: string }
  // Held: why, the POD's date, and whether a person's press could carry out a card for it (a
  // press refuses a date after today or before the pickup date).
  | { kind: "held"; reason: MoveReason; day: LocalDate | null; pressable: boolean };

// The POD step on an in transit load, by the paper rules: delivered on the POD's own date when it
// is in the POD window, not after today, and the load has a driver.
async function deliverOnPod(
  q: Queryable,
  load: LockedLoad,
  podDoc: PaperDocument,
  today: LocalDate,
  zone: string,
): Promise<PodStep> {
  const day = paperDateOf(podDoc);
  if (day === null || day > today || !podWindowHolds(paperLoad(load), day)) {
    const pressable = day === null || (day <= today && day >= load.pickup_on);
    return { kind: "held", reason: "date_out_of_window", day, pressable };
  }
  if (load.driver_id === null) return { kind: "held", reason: "no_driver", day, pressable: true };
  const times = stopTimesOf(podDoc, "delivery", zone);
  const deliveredAt = deliveredAtOf(day, times, zone);
  const event = await writeStep(
    q,
    load,
    { to: "delivered", at: deliveredAt, deliveredOn: day, deliveredAt, times },
    "driver_photo",
    { table: "documents", id: podDoc.id },
  );
  return { kind: "moved", event };
}

// Right after a move to in transit by a note, a press or the demo feed: a POD already read in
// (read first, so its own look found the load still planned) delivers the load now, by the same
// paper rules and the same switch. Never a card. The delivered event's id, or null.
async function deliverOnPaperIn(q: Queryable, load: LockedLoad, today: LocalDate, zone: string): Promise<string | null> {
  if (load.status !== "in_transit" || !automaticOn(today)) return null;
  const docs = (await papersOf(q, load.id, zone)).map(toPaper);
  const paper = paperworkOf(paperLoad(load), docs);
  const podDoc = paper.pod ? docs.find((d) => d.id === paper.pod) : undefined;
  if (!podDoc || !automaticOn(localDateOf(podDoc.createdAt, zone))) return null;
  const r = await deliverOnPod(q, load, podDoc, today, zone);
  return r.kind === "moved" ? r.event : null;
}

// Inside the desk's tenant transaction: what one read document does to its load. Only a rate
// confirmation or bill of lading matched to one load (whole load number, match.ts) is looked at; a
// document with no single load is never discovered (src/lib/desk/discover.ts).
export async function moveFromDocument(
  q: Queryable,
  session: Session,
  documentId: string,
  now: Date,
): Promise<MoveOutcome> {
  if (!isUuid(documentId)) return { kind: "nothing", category: "validation" };
  const [row] = await q.query<DocRow>(
    `SELECT ${DOC_COLUMNS} FROM documents WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [documentId],
  );
  if (!row) return { kind: "nothing", category: "not_found" };
  const doc = toPaper(row);
  if (doc.readStatus !== "read" || (doc.kind !== "bill_of_lading" && doc.kind !== "rate_confirmation")) {
    return { kind: "nothing", category: "not_load_paper" };
  }
  const zone = await zoneOf(q);
  if (!automaticOn(localDateOf(doc.createdAt, zone))) return { kind: "nothing", category: "switched_off" };
  const loadId = matchedLoadId(doc.match);
  if (!loadId) return { kind: "nothing", category: "not_matched" };
  // A rate confirmation fills no status (the advance, a later item, reads it as "rated").
  if (doc.kind === "rate_confirmation") return { kind: "nothing", category: "rate_paper" };
  const load = await lockLoad(q, loadId);
  if (!load) return { kind: "nothing", category: "not_found" };

  const docs = (await papersOf(q, load.id, zone)).map(toPaper);
  const pl = paperLoad(load);
  const paper = paperworkOf(pl, docs);
  const today = localDateOf(now.toISOString(), zone);
  const evidence: Evidence = { table: "documents", id: doc.id };
  const inputId = row.untrusted_input_id;
  const cardOn = (reason: MoveReason, toStatus: MoveTo | null, deliveredOn?: LocalDate | null) =>
    card(q, session, now, {
      reason,
      subject: { table: "loads", id: load.id },
      loadId: load.id,
      toStatus,
      deliveredOn,
      evidence,
      inputId,
    });

  // A cancelled load never moves, so a card for it could never be carried out.
  if (load.status === "cancelled") return { kind: "nothing", category: "wrong_status" };
  if (load.status === "delivered" || load.status === "invoiced") return { kind: "already", loadId: load.id };

  const byId = new Map(docs.map((d) => [d.id, d]));
  const pickupDoc = paper.pickupBol ? byId.get(paper.pickupBol) : undefined;
  const podDoc = paper.pod ? byId.get(paper.pod) : undefined;
  const events: string[] = [];

  if (load.status === "planned") {
    if (!pickupDoc) {
      // A POD on a planned load: a card asking for delivered could never be carried out.
      if (podDoc) return { kind: "nothing", category: "no_pickup_paper" };
      const why = whyNotCounted(pl, doc, paper);
      return why && why !== "not_read" && why !== "not_matched" ? cardOn(why, null) : { kind: "nothing", category: "no_pickup_paper_yet" };
    }
    const date = paperDateOf(pickupDoc);
    if (date === null || date > today || !pickupWindowHolds(pl, date)) return cardOn("date_out_of_window", "in_transit");
    const times = stopTimesOf(pickupDoc, "pickup", zone);
    events.push(
      await writeStep(q, load, { to: "in_transit", at: times?.departedAt ?? pickupDoc.createdAt, times }, "driver_photo", {
        table: "documents",
        id: pickupDoc.id,
      }),
    );
  }

  if (load.status === "in_transit" && podDoc) {
    const r = await deliverOnPod(q, load, podDoc, today, zone);
    if (r.kind === "moved") events.push(r.event);
    else if (events.length > 0) return moved(load, events);
    // A card a person's press would refuse could never be carried out.
    else if (!r.pressable) return { kind: "nothing", category: r.reason };
    else return cardOn(r.reason, "delivered", r.day);
  }

  if (events.length > 0) return moved(load, events);
  // In transit and this paper is not the POD: a paper that does not count is a card.
  const why = whyNotCounted(pl, doc, paper);
  if (why && why !== "not_read" && why !== "not_matched") return cardOn(why, null);
  return { kind: "already", loadId: load.id };
}

const moved = (load: LockedLoad, events: string[]): MoveOutcome => ({
  kind: "moved",
  loadId: load.id,
  to: load.status as MoveTo,
  events,
});

// ---------------------------------------------------------------------------------------------
// The message path: a driver's text or voice note Muse Spark sorted as load_update.

export type MessageTable = "inbound_messages" | "voice_notes";

type MessageRow = {
  id: string;
  driver_id: string | null;
  input_id: string | null;
  text: string | null;
  triage_category: string | null;
  at: string;
};

export const LOAD_UPDATE = "load_update";

async function readMessage(q: Queryable, table: MessageTable, id: string): Promise<MessageRow | null> {
  const rows = await q.query<MessageRow>(
    table === "inbound_messages"
      ? `SELECT CAST(m.id AS text) AS id, CAST(m.driver_id AS text) AS driver_id,
                CAST(m.input_id AS text) AS input_id, u.body_text AS text, m.triage_category,
                ${ts("m.received_at")} AS at
           FROM inbound_messages m
           LEFT JOIN untrusted_inputs u ON u.tenant_id = m.tenant_id AND u.id = m.input_id
          WHERE m.tenant_id = current_tenant_id() AND m.id = CAST($1 AS uuid)`
      : `SELECT CAST(v.id AS text) AS id, CAST(v.driver_id AS text) AS driver_id,
                CAST(v.input_id AS text) AS input_id, v.english_text AS text, v.triage_category,
                ${ts("v.created_at")} AS at
           FROM voice_notes v
          WHERE v.tenant_id = current_tenant_id() AND v.id = CAST($1 AS uuid)`,
    [id],
  );
  return rows[0] ?? null;
}

// The loads whose number the text names whole, among every load of the carrier's that is not
// cancelled: an invoiced load named beside another makes the note ambiguous, never a move.
async function namedLoads(q: Queryable, text: string): Promise<LockedLoad[]> {
  const loads = await q.query<LockedLoad>(
    `SELECT ${LOAD_COLUMNS} FROM loads
      WHERE tenant_id = current_tenant_id() AND status <> 'cancelled'
      ORDER BY load_number, id`,
  );
  return loads.filter((l) => namesWhole(text, l.load_number));
}

// Whether a load_move card about this driver still waits or runs: a second unclear note from the
// same driver then leaves that card alone (the engine would retire it for different args).
async function driverCardLive(q: Queryable, driverId: string): Promise<boolean> {
  const rows = await q.query<{ one: number }>(
    `SELECT 1 AS one FROM proposals
      WHERE tenant_id = current_tenant_id() AND kind = 'load_move' AND subject_table = 'drivers'
        AND subject_id = CAST($1 AS uuid) AND status IN ('proposed', 'approved', 'executing')
      LIMIT 1`,
    [driverId],
  );
  return rows.length > 0;
}

// Inside the desk's tenant transaction, after Muse Spark sorted the message as load_update: code
// checks the whole load number and the sender, then makes the same move a paper would, with the
// message time as the time. Anything less is a card, or nothing when a card could never be carried
// out or one already waits for that driver; a message with no driver is left alone.
export async function moveFromMessage(
  q: Queryable,
  session: Session,
  table: MessageTable,
  messageId: string,
  now: Date,
): Promise<MoveOutcome> {
  if (!isUuid(messageId)) return { kind: "nothing", category: "validation" };
  const msg = await readMessage(q, table, messageId);
  if (!msg) return { kind: "nothing", category: "not_found" };
  if (msg.triage_category !== LOAD_UPDATE) return { kind: "nothing", category: "not_load_update" };
  if (msg.driver_id === null) return { kind: "nothing", category: "no_sender" };
  const zone = await zoneOf(q);
  const day = localDateOf(msg.at, zone);
  if (!automaticOn(day)) return { kind: "nothing", category: "switched_off" };
  const evidence: Evidence = { table, id: msg.id };
  const source: MoveSource = table === "inbound_messages" ? "driver_text" : "driver_voice";
  const text = msg.text ?? "";
  const driverCard = async (reason: MoveReason): Promise<MoveOutcome> => {
    const driverId = msg.driver_id as string;
    if (await driverCardLive(q, driverId)) return { kind: "nothing", category: "driver_card_waiting" };
    return card(q, session, now, {
      reason,
      subject: { table: "drivers", id: driverId },
      loadId: null,
      toStatus: null,
      evidence,
      inputId: msg.input_id,
    });
  };

  const named = await namedLoads(q, text);
  if (named.length === 0) return driverCard("no_load_number");
  if (named.length > 1) return driverCard("ambiguous_load");
  const load = await lockLoad(q, named[0].id);
  if (!load) return driverCard("no_load_number");
  // One load named, and it has moved on past delivered (or was cancelled since): nothing to move
  // and no card; the message goes on as before.
  if (load.status !== "planned" && load.status !== "in_transit" && load.status !== "delivered") {
    return { kind: "nothing", category: "not_movable" };
  }
  const to = directionOf(text);
  const cardOn: CardOn = (reason, toStatus, deliveredOn) =>
    card(q, session, now, {
      reason,
      subject: { table: "loads", id: load.id },
      loadId: load.id,
      toStatus,
      deliveredOn,
      evidence,
      inputId: msg.input_id,
    });
  if (load.driver_id !== msg.driver_id) return cardOn("wrong_driver", to);
  // Unclear: a card with no step could never be carried out; the message goes on as before.
  if (to === null) return { kind: "nothing", category: "unclear_update" };
  const r = await applyMove(q, load, to, { at: msg.at, day, zone, today: localDateOf(now.toISOString(), zone) }, source, evidence, cardOn);
  return r.kind === "refused" ? cardOn(r.reason, to) : r;
}

// times: the stop's arrived and departed, when the evidence gives both (the dispatch path).
// ---------------------------------------------------------------------------------------------
// The dispatch path (TMS-MIRROR, 0075): a status event mirrored from the tenant's TMS.

type TmsEventRow = {
  id: string;
  field: string;
  new_value: string | null;
  clock_flag: string | null;
  day: string;
  at: string;
  seeded: boolean;
  gone: boolean;
  tms_load_id: string;
  load_id: string | null;
  label_map: string | null;
  // The mirror's finalize state: its recheck has not passed yet, or it saw an edit after it.
  awaiting_recheck: boolean;
  edited_after_finalize: boolean;
};

type TmsStopRow = {
  arrived_utc: string | null;
  arrived_local: string | null;
  arrived_at: string | null;
  completed_utc: string | null;
  completed_local: string | null;
  completed_at: string | null;
};

// Whether the dispatch path may act on a day: the sync is on and the day is on or after its start.
export function tmsOn(day: LocalDate): boolean {
  const s = flags.tmsSync;
  return s.enabled === true && isLocalDate(s.startDate) && day >= s.startDate;
}

// The one stop of a kind with both times, its clocks agreeing; null times when the load has no
// such single stop (a multi-stop load gives no times, never a guess), "unclear" on a clock flag.
async function tmsStopTimes(
  q: Queryable,
  tmsLoadId: string,
  kind: "pickup" | "delivery",
  zone: string,
): Promise<StopTimes | "unclear"> {
  const stops = await q.query<TmsStopRow>(
    `SELECT ${ts("arrived_utc")} AS arrived_utc, arrived_local, ${ts("arrived_at")} AS arrived_at,
            ${ts("completed_utc")} AS completed_utc, completed_local, ${ts("completed_at")} AS completed_at
       FROM tms_stops
      WHERE tenant_id = current_tenant_id() AND tms_load_id = CAST($1 AS uuid) AND stop_kind = $2
      ORDER BY ordinal`,
    [tmsLoadId, kind],
  );
  if (stops.length !== 1) return null;
  const s = stops[0];
  for (const [utc, local] of [
    [s.arrived_utc, s.arrived_local],
    [s.completed_utc, s.completed_local],
  ] as const) {
    if (local !== null && resolve({ utc, local }, zone).flag !== null) return "unclear";
  }
  if (s.arrived_at === null || s.completed_at === null) return null;
  if (Date.parse(s.completed_at) < Date.parse(s.arrived_at)) return null;
  return { arrivedAt: s.arrived_at, departedAt: s.completed_at };
}

// Inside the desk's tenant transaction: what one mirrored status event does to our linked load.
// The event's label maps through the tenant's label map to a fixed code (src/lib/tms/status.ts);
// in transit and delivered are moves under the same rules as a driver's message, withdrawn on a
// load we still run is a card, finalized drafts our delivered load's invoice card (S3), and every
// other code is recorded only. A clock flag on the times the move would use is a card, never a
// move. Nothing is read from or sent to the TMS here.
export async function moveFromTmsEvent(
  q: Queryable,
  session: Session,
  eventId: string,
  now: Date,
): Promise<MoveOutcome> {
  if (!isUuid(eventId)) return { kind: "nothing", category: "validation" };
  if (flags.tmsSync.enabled !== true) return { kind: "nothing", category: "switched_off" };
  const [row] = await q.query<TmsEventRow>(
    `SELECT CAST(e.id AS text) AS id, e.field, e.new_value, e.clock_flag, to_char(e.day, 'YYYY-MM-DD') AS day,
            ${ts("e.at")} AS at, e.seeded, (l.gone_at IS NOT NULL) AS gone,
            CAST(e.tms_load_id AS text) AS tms_load_id, CAST(l.load_id AS text) AS load_id,
            CAST(c.label_map AS text) AS label_map,
            (l.finalized_seen_at IS NULL OR l.recheck_after IS NOT NULL) AS awaiting_recheck,
            (l.flags @> '["edited_after_finalize"]'::jsonb) AS edited_after_finalize
       FROM tms_status_events e
       JOIN tms_loads l ON l.tenant_id = e.tenant_id AND l.id = e.tms_load_id
       LEFT JOIN tms_connections c ON c.tenant_id = e.tenant_id
      WHERE e.tenant_id = current_tenant_id() AND e.id = CAST($1 AS uuid)`,
    [eventId],
  );
  if (!row) return { kind: "nothing", category: "not_found" };
  if (row.seeded) return { kind: "nothing", category: "seeded" };
  if (row.field !== "status") return { kind: "nothing", category: "recorded" };
  if (row.gone) return { kind: "nothing", category: "gone" };
  if (!tmsOn(row.day)) return { kind: "nothing", category: "before_start" };
  if (!automaticOn(row.day)) return { kind: "nothing", category: "switched_off" };
  const code = codeOf(row.new_value, readLabelMap(parseJson(row.label_map)));
  if (row.load_id === null) return { kind: "nothing", category: "unlinked" };
  const load = await lockLoad(q, row.load_id);
  if (!load) return { kind: "nothing", category: "unlinked" };
  const evidence: Evidence = { table: "tms_status_events", id: row.id };
  const cardOn: CardOn = (reason, toStatus, deliveredOn) =>
    card(q, session, now, {
      reason,
      subject: { table: "loads", id: load.id },
      loadId: load.id,
      toStatus,
      deliveredOn,
      evidence,
    });
  if (isWithdrawn(code)) {
    return load.status === "planned" || load.status === "in_transit"
      ? cardOn("tms_withdrawn", null)
      : { kind: "nothing", category: "recorded" };
  }
  // TMS-MIRROR (S3): finalized there drafts our delivered load's invoice card, from our own loads
  // row (src/lib/invoices/finalize.ts asks its own switch and start date). Only once the mirror's
  // recheck after the cool-off has read the load again; until then the event waits. An edit there
  // after the finalize is for a person, never drafted. Invoiced and paid there are recorded only.
  // Never a move.
  if (code === "finalized") {
    if (!finalizeInvoiceOn(row.day)) return { kind: "nothing", category: "recorded" };
    if (row.edited_after_finalize === true) return { kind: "nothing", category: "edited_after_finalize" };
    if (row.awaiting_recheck !== false) return { kind: "waiting", category: "awaiting_recheck" };
    return proposeInvoiceOnFinalize(q, session, load.id, row.day, now);
  }
  const to = moveOf(code);
  if (to === null) return { kind: "nothing", category: "recorded" };
  if (load.status === "cancelled") return { kind: "nothing", category: "wrong_status" };
  const zone = await zoneOf(q);
  const times = await tmsStopTimes(q, row.tms_load_id, to === "in_transit" ? "pickup" : "delivery", zone);
  if (row.clock_flag !== null || times === "unclear") {
    const reached =
      load.status === "invoiced" || load.status === "delivered" || (to === "in_transit" && load.status === "in_transit");
    return reached ? { kind: "already", loadId: load.id } : cardOn("tms_time_unclear", to, to === "delivered" ? row.day : null);
  }
  const at = times?.departedAt ?? row.at;
  const r = await applyMove(
    q,
    load,
    to,
    { at, day: row.day, zone, today: localDateOf(now.toISOString(), zone), times },
    "tms",
    evidence,
    cardOn,
  );
  return r.kind === "refused" ? cardOn(r.reason, to) : r;
}

// From the sync, inside its per-load transaction: a load deleted in the TMS that we still run is
// one card for a person (never a move, never a retry). Same gates as an event, on today's date.
export async function tmsGoneCard(q: Queryable, session: Session, loadId: string, now: Date): Promise<MoveOutcome> {
  if (!isUuid(loadId)) return { kind: "nothing", category: "validation" };
  const zone = await zoneOf(q);
  const today = localDateOf(now.toISOString(), zone);
  if (!tmsOn(today) || !automaticOn(today)) return { kind: "nothing", category: "switched_off" };
  const load = await lockLoad(q, loadId);
  if (!load) return { kind: "nothing", category: "not_found" };
  if (load.status !== "planned" && load.status !== "in_transit" && load.status !== "delivered") {
    return { kind: "nothing", category: "recorded" };
  }
  return card(q, session, now, {
    reason: "tms_gone",
    subject: { table: "loads", id: load.id },
    loadId: load.id,
    toStatus: null,
    evidence: null,
  });
}

type When = { at: Instant; day: LocalDate; zone: string; today: LocalDate; times?: StopTimes };

type CardOn = (reason: MoveReason, toStatus: MoveTo | null, deliveredOn?: LocalDate | null) => Promise<MoveOutcome>;

// One move asked for by a message (cardOn set: a refusal is a card) or a person (cardOn null: a
// refusal is returned). The status before it must be the one the move starts from and the date is
// never after today. A message's date must also be in the paper windows; a person, who knows, may
// date a move any day from the load's pickup date on.
async function applyMove(
  q: Queryable,
  load: LockedLoad,
  to: MoveTo,
  when: When,
  source: MoveSource,
  evidence: Evidence | null,
  cardOn: CardOn | null,
): Promise<MoveOutcome | { kind: "refused"; reason: MoveReason }> {
  const refuse = (reason: MoveReason, deliveredOn?: LocalDate | null) =>
    cardOn ? cardOn(reason, to, deliveredOn) : Promise.resolve({ kind: "refused" as const, reason });
  const pl = paperLoad(load);
  const inWindow = (day: LocalDate) =>
    day <= when.today &&
    (cardOn === null
      ? day >= load.pickup_on
      : to === "in_transit"
        ? pickupWindowHolds(pl, day)
        : podWindowHolds(pl, day));
  const reached =
    (to === "in_transit" && (load.status === "in_transit" || load.status === "delivered" || load.status === "invoiced")) ||
    (to === "delivered" && (load.status === "delivered" || load.status === "invoiced"));
  if (reached) return { kind: "already", loadId: load.id };
  if (to === "in_transit") {
    if (load.status !== "planned") return refuse("wrong_status");
    if (!inWindow(when.day)) return refuse("date_out_of_window");
    const id = await writeStep(q, load, { to: "in_transit", at: when.at, times: when.times ?? null }, source, evidence);
    const delivered = await deliverOnPaperIn(q, load, when.today, when.zone);
    return moved(load, delivered ? [id, delivered] : [id]);
  }
  if (load.status !== "in_transit") return refuse("wrong_status", when.day);
  if (!inWindow(when.day)) return refuse("date_out_of_window", when.day);
  if (load.driver_id === null) return refuse("no_driver", when.day);
  const deliveredAt = when.day === localDateOf(when.at, when.zone) ? when.at : instantAt(when.day, 17, 0, when.zone);
  const id = await writeStep(
    q,
    load,
    { to: "delivered", at: deliveredAt, deliveredOn: when.day, deliveredAt, times: when.times ?? null },
    source,
    evidence,
  );
  return moved(load, [id]);
}

// ---------------------------------------------------------------------------------------------
// A person's press: Mark picked up and Mark delivered on a load, and a load_move card approved.

export type StaffMoveResult =
  | { ok: true; changed: boolean; to: MoveTo }
  | { ok: false; category: "validation" | "not_found" | MoveReason };

// Inside a tenant transaction the caller holds, after the caller checked staff. A delivery dated
// today is at the press; an earlier day (a card's POD date) is at the carrier's 17:00 that day.
export async function staffMoveIn(
  q: Queryable,
  loadId: string,
  to: MoveTo,
  now: Date,
  deliveredOn: LocalDate | null = null,
): Promise<StaffMoveResult> {
  if (!isUuid(loadId) || (to !== "in_transit" && to !== "delivered")) return { ok: false, category: "validation" };
  if (deliveredOn !== null && !isLocalDate(deliveredOn)) return { ok: false, category: "validation" };
  const zone = await zoneOf(q);
  const load = await lockLoad(q, loadId);
  if (!load) return { ok: false, category: "not_found" };
  const today = localDateOf(now.toISOString(), zone);
  const day = to === "delivered" && deliveredOn !== null ? deliveredOn : today;
  const r = await applyMove(q, load, to, { at: now.toISOString(), day, zone, today }, "staff", null, null);
  if (r.kind === "already") return { ok: true, changed: false, to };
  if (r.kind === "moved") return { ok: true, changed: true, to };
  if (r.kind === "refused") return { ok: false, category: r.reason };
  return { ok: false, category: "wrong_status" };
}

// POST /api/loads/[id]/move: membership, staff, then the move, in one tenant transaction.
export async function staffMove(
  db: TenantDb,
  session: Session,
  loadId: string,
  to: unknown,
  now: Date,
): Promise<StaffMoveResult> {
  if (!isUuid(loadId) || (to !== "in_transit" && to !== "delivered")) return { ok: false, category: "validation" };
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    await requireStaff(q, session);
    return staffMoveIn(q, loadId, to, now);
  });
}

// ---------------------------------------------------------------------------------------------
// Settings > Demo's Move the fleet: the stand-in for a dispatch feed, source demo_feed.

export const FLEET_MOVES_PER_PRESS = 3;

export type FleetMoveResult = { pickedUp: number; delivered: number };

// Inside a tenant transaction the caller holds, after the caller checked staff and the demo
// carrier. Oldest first, at most three moves a press: planned loads whose pickup day has come go
// in transit, and in transit loads picked up before today with a driver are delivered today. The
// hero driver's loads are left for the walk-through.
export async function moveFleetIn(q: Queryable, now: Date, keepDriverId: string | null): Promise<FleetMoveResult> {
  const zone = await zoneOf(q);
  const today = localDateOf(now.toISOString(), zone);
  const rows = await q.query<LockedLoad>(
    `SELECT ${LOAD_COLUMNS} FROM loads
      WHERE tenant_id = current_tenant_id()
        AND ((status = 'planned' AND pickup_on <= CAST($1 AS date))
          OR (status = 'in_transit' AND driver_id IS NOT NULL AND pickup_on < CAST($1 AS date)))
        AND (CAST($2 AS uuid) IS NULL OR driver_id IS NULL OR driver_id <> CAST($2 AS uuid))
      ORDER BY pickup_on, load_number, id
      LIMIT ${FLEET_MOVES_PER_PRESS}
      FOR UPDATE`,
    [today, keepDriverId],
  );
  const out: FleetMoveResult = { pickedUp: 0, delivered: 0 };
  for (const load of rows) {
    if (load.status === "planned") {
      await writeStep(q, load, { to: "in_transit", at: now.toISOString(), times: null }, "demo_feed", null);
      out.pickedUp += 1;
      if (await deliverOnPaperIn(q, load, today, zone)) out.delivered += 1;
    } else {
      const at = now.toISOString();
      await writeStep(q, load, { to: "delivered", at, deliveredOn: today, deliveredAt: at, times: null }, "demo_feed", null);
      out.delivered += 1;
    }
  }
  return out;
}
