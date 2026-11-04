// Synthetic journey facts for the journey tests and the page word scan: one load at each stage of
// its road, from planned to paid and recorded. Made-up names, numbers and ids only.
import { CONFIDENCE_FIELDS, type ConfidenceField, type DocumentRead, type FieldConfidence } from "../documents/types";
import type { JourneyCard, JourneyDocument, JourneyFacts, JourneyMoney, JourneyOptions, JourneySettlement } from "./steps";

export const ZONE = "America/Chicago";
export const OPTS: JourneyOptions = { zone: ZONE, books: { enabled: true, startDate: "2026-10-01", maxAttempts: 5 } };

export const LOAD_ID = "6b1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const DRIVER_ID = "7c2a3b4d-5e6f-4b7c-9d8e-1f2a3b4c5d6e";
const DOC_BOL = "8d3b4c5e-6f7a-4c8d-ae9f-2a3b4c5d6e7f";
const DOC_POD = "9e4c5d6f-7a8b-4d9e-bfa0-3b4c5d6e7f80";
const SETTLEMENT_ID = "0f5d6e7a-8b9c-4eaf-80b1-4c5d6e7f8091";
const ADVANCE_ID = "1a6e7f8b-9cad-4fb0-91c2-5d6e7f8091a2";

const CONFIDENCE = Object.fromEntries(CONFIDENCE_FIELDS.map((k) => [k, "high"])) as Record<ConfidenceField, FieldConfidence>;

function readOf(role: "pickup" | "delivery"): DocumentRead {
  return {
    kind: "bill_of_lading",
    fields: {
      sampleWord: true,
      vendor: null,
      date: "11/02/2026",
      totalCents: null,
      loadNumber: "L-20417",
      truckUnit: "T-118",
      gallonsMilli: null,
      priceCents: null,
      loadedMiles: null,
      ratePerMileCents: null,
      linehaulCents: null,
      fuelSurchargeCents: null,
      customerName: "Harbor Paper Co",
      stops: [{ role, arrived: "11/02/2026 08:10", departed: "11/02/2026 09:05" }],
    },
    textLines: ["SAMPLE"],
    confidence: { ...CONFIDENCE, truck_unit: "low" },
  };
}

export function documentOf(id: string, role: "pickup" | "delivery"): JourneyDocument {
  return {
    id,
    filename: role === "pickup" ? "bol-l20417.jpg" : "pod-l20417.jpg",
    mime: "image/jpeg",
    kind: "bill_of_lading",
    readStatus: "read",
    stalled: false,
    read: readOf(role),
    match: {
      found: true,
      table: "loads",
      id: LOAD_ID,
      humanRef: "L-20417",
      loadId: LOAD_ID,
      driverId: DRIVER_ID,
      fields: [
        { name: "load_number", claim: "L-20417", record: "L-20417", status: "same" },
        { name: "truck_unit", claim: "T-118", record: "T-118", status: "low_confidence" },
      ],
      notes: [],
      supports: null,
    },
  };
}

const money = (kind: JourneyMoney["kind"], amountCents: number, at: string, more: Partial<JourneyMoney> = {}): JourneyMoney => ({
  kind,
  attempt: 1,
  state: "confirmed",
  failureCategory: null,
  amountCents,
  outsideSystem: kind.startsWith("settlement_bill") || kind === "advance_expense" ? "qbo_sandbox" : "fuel_card_sim",
  outsideId: kind.startsWith("settlement_bill") || kind === "advance_expense" ? `qb-${kind}-0042${kind.length}` : null,
  settledAt: at,
  createdAt: at,
  ...more,
});

export function advanceCard(more: Partial<JourneyCard> = {}): JourneyCard {
  return {
    id: "2b7f8091-adbe-4c01-a2d3-6e7f8091a2b3",
    status: "done",
    amountCents: 15_000,
    createdAt: "2026-11-02T15:06:00.000Z",
    auditVerdict: "pass",
    autopilotMode: "ask",
    decidedAt: "2026-11-02T15:20:00.000Z",
    decidedBy: "admin",
    ...more,
  };
}

function settlement(more: Partial<JourneySettlement> = {}): JourneySettlement {
  return {
    id: SETTLEMENT_ID,
    status: "paid",
    grossCents: 240_000,
    deductionsCents: 30_500,
    netCents: 209_500,
    paidAt: "2026-11-06T17:00:00.000Z",
    parkedReason: null,
    createdAt: "2026-11-06T14:00:00.000Z",
    periodStart: "2026-11-02",
    periodEnd: "2026-11-08",
    lines: [
      { seq: 1, kind: "load_pay", label: "Load pay, load L-20417", amountCents: 240_000, sources: [{ table: "loads", id: LOAD_ID }], meta: null },
      { seq: 2, kind: "advance_recovery", label: "Advance recovery (2026-11-02)", amountCents: -15_000, sources: [{ table: "advances", id: ADVANCE_ID }], meta: null },
      { seq: 3, kind: "insurance", label: "Insurance", amountCents: -5_500, sources: [], meta: { days: 5, perDayCents: 1_100 } },
      { seq: 4, kind: "escrow", label: "Escrow", amountCents: -10_000, sources: [], meta: { balanceBeforeCents: 40_000, targetCents: 250_000 } },
    ],
    card: advanceCard({ id: "3c809102-becf-4d12-b3e4-7f8091a2b3c4", amountCents: 209_500, createdAt: "2026-11-06T14:00:00.000Z", decidedAt: "2026-11-06T16:55:00.000Z" }),
    legs: [
      money("settlement_payout", 209_500, "2026-11-06T17:00:00.000Z", { outsideSystem: "stripe_test" }),
      money("settlement_bill", 209_500, "2026-11-06T17:01:00.000Z"),
      money("settlement_bill_payment", 209_500, "2026-11-06T17:02:00.000Z"),
    ],
    ...more,
  };
}

// The whole road walked: picked up and delivered by the driver's photos, advance paid and booked,
// paystub paid and booked.
export function fullChain(): JourneyFacts {
  return {
    load: {
      id: LOAD_ID,
      number: "L-20417",
      status: "delivered",
      driverId: DRIVER_ID,
      driverName: "Rosa Delgado",
      origin: "Joliet, IL",
      destination: "Memphis, TN",
      pickedUpAt: "2026-11-02T15:05:00.000Z",
      deliveredAt: "2026-11-03T20:40:00.000Z",
    },
    moves: [
      {
        id: "4d9102a3-cfd0-4e23-84f5-8091a2b3c4d5",
        toStatus: "in_transit",
        source: "driver_photo",
        at: "2026-11-02T15:05:00.000Z",
        document: documentOf(DOC_BOL, "pickup"),
        desk: { kind: "done", category: "advance_proposed", at: "2026-11-02T15:06:00.000Z" },
      },
      {
        id: "5ea213b4-d0e1-4f34-95a6-91a2b3c4d5e6",
        toStatus: "delivered",
        source: "driver_photo",
        at: "2026-11-03T20:40:00.000Z",
        document: documentOf(DOC_POD, "delivery"),
        desk: null,
      },
    ],
    card: advanceCard(),
    advance: {
      id: ADVANCE_ID,
      status: "paid",
      amountCents: 15_000,
      paidAt: "2026-11-02T15:21:00.000Z",
      createdAt: "2026-11-02T15:20:00.000Z",
      proposalId: "2b7f8091-adbe-4c01-a2d3-6e7f8091a2b3",
    },
    advanceMoney: [
      money("advance_payout", 15_000, "2026-11-02T15:21:00.000Z"),
      money("advance_expense", 15_000, "2026-11-02T15:22:00.000Z"),
    ],
    settlement: settlement(),
    dispatch: { truck: "T-118", dueLocal: "2026-11-03T16:00" },
  };
}

// A load planned with a driver and nothing else yet.
export function emptyChain(): JourneyFacts {
  const f = fullChain();
  return {
    ...f,
    load: { ...f.load, status: "planned", pickedUpAt: null, deliveredAt: null },
    moves: [],
    card: null,
    advance: null,
    advanceMoney: [],
    settlement: null,
  };
}

// Picked up by photo, the advance card drafted and waiting for a person.
export function atAdvanceCard(): JourneyFacts {
  const f = fullChain();
  return {
    ...f,
    load: { ...f.load, status: "in_transit", deliveredAt: null },
    moves: [f.moves[0]],
    card: advanceCard({ status: "proposed", decidedAt: null, decidedBy: null }),
    advance: null,
    advanceMoney: [],
    settlement: null,
  };
}

// The advance's payout came back failed.
export function failedPayout(): JourneyFacts {
  const f = atAdvanceCard();
  return {
    ...f,
    card: advanceCard({ status: "failed" }),
    advance: { ...fullChain().advance!, status: "approved", paidAt: null },
    advanceMoney: [money("advance_payout", 15_000, "2026-11-02T15:21:00.000Z", { state: "failed", failureCategory: "declined" })],
  };
}
