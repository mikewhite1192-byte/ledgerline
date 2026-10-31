import type { Queryable } from "../../db";
import type { Instant } from "../../time/local-date";

// TMS-MIRROR (0075): the read-only contract for a dispatch system (a TMS). Built for the worst
// case: no change feed and no cursor (the walk is newest created first, resumed below a
// (createdAt, id) bookmark), list rows that may be stale or thin (they only pick candidates; every
// write comes from a full read by id), hard deletes (a read by id that finds nothing is gone,
// never a retry), and two clocks on every time (a UTC field that may be wrong, a local field with
// no offset). Nothing here can write to the outside system: there is no member that creates,
// changes, uploads or sends anything (adapter-surface.test.ts).

// A time as the system stores it: the UTC field (null when the system left it out) and the local
// field, `YYYY-MM-DDTHH:mm` with no offset.
export type TwoClocks = { utc: Instant | null; local: string };

// The walk resumes below this row: newest created first, ties by id.
export type ListBookmark = { createdAt: Instant; id: string };

// A read by id: the record, or gone (deleted upstream). An unknown outcome (a timeout, a server
// fault, a body that fails validation) is never a Read: it throws TmsSourceError.
export type Read<T> = { kind: "ok"; value: T; asOf: Instant } | { kind: "gone" };

export type TmsListRow = {
  externalId: string;
  createdAt: Instant;
  updatedAt: Instant;
  statusLabel: string;
  reference: string | null;
  driverExternalId: string | null;
};

// No reliable sequence: kept in the order given.
export type TmsStopRecord = {
  name: string;
  city: string;
  state: string;
  apptFromLocal: string | null;
  apptToLocal: string | null;
  arrived: TwoClocks | null;
  completed: TwoClocks | null;
};

export type TmsLoadRecord = {
  externalId: string;
  reference: string;
  statusLabel: string;
  customer: { externalId: string; name: string } | null;
  driverExternalId: string | null;
  truckUnit: string | null;
  trailerUnit: string | null;
  vin: string | null;
  pickups: TmsStopRecord[];
  deliveries: TmsStopRecord[];
  stopCount: number;
  legCount: number;
  pickedUp: TwoClocks | null;
  delivered: TwoClocks | null;
  lastDeliveryCompleted: TwoClocks | null;
  revenueTotalCents: number | null;
  driverPayTotalCents: number | null;
  updatedAt: Instant;
  finalizedAt: Instant | null;
};

export type TmsHistoryRow = {
  externalId: string;
  field: string;
  newValue: string | null;
  previousValue: string | null;
  changedBy: string | null;
  at: TwoClocks;
};

// No status, no created time, no stop link, and never a file address.
export type TmsDocumentRow = {
  externalId: string;
  fileName: string;
  typeLabel: string;
  shared: boolean;
  updatedAt: Instant;
  byteLength: number;
  uploaderKind: "driver_app" | "office" | "unknown";
};

export type TmsLineItem = {
  externalId: string;
  group: "revenue" | "driver_pay" | "accessorial";
  typeLabel: string;
  description: string;
  amountCents: number;
};

export type TmsPartyKind = "customer" | "driver" | "truck" | "trailer";

export type TmsPartyRecord = {
  partyKind: TmsPartyKind;
  externalId: string;
  name: string;
  unit: string | null;
  vin: string | null;
};

export const TMS_FAILURES = ["unreachable", "unauthorized", "rate_limited", "malformed", "server_error", "timeout"] as const;
export type TmsFailure = (typeof TMS_FAILURES)[number];

// An unknown outcome, as a category only: the raw cause goes to the log, never to a row or a reply.
export class TmsSourceError extends Error {
  constructor(public readonly category: TmsFailure) {
    super(category);
    this.name = "TmsSourceError";
  }
}

// The tenant's connection row (tms_connections), as the adapters see it.
export type TmsConnection = {
  id: string;
  system: "synthetic";
  labelMap: Record<string, string>;
  lookbackHours: number;
  finalizeCooloffMinutes: number;
  // The synthetic feed's clock never reads earlier than this (the seeded snapshot's instant).
  feedFloorAt: Instant | null;
};

export type TmsContext = { tenantId: string; zone: string; now: Instant; q: Queryable; connection: TmsConnection };

export interface TmsSource {
  // A vendor adds its own literal here; never a vendor name in this repo.
  readonly system: "synthetic";
  ready(ctx: TmsContext): Promise<{ ok: true } | { ok: false; category: TmsFailure }>;
  listLoads(ctx: TmsContext, below: ListBookmark | null, limit: number): Promise<{ rows: TmsListRow[]; next: ListBookmark | null }>;
  readLoad(ctx: TmsContext, externalId: string): Promise<Read<TmsLoadRecord>>;
  // Page from 0 until an empty page; duplicates across pages are dropped by externalId.
  readHistory(ctx: TmsContext, externalId: string, page: number): Promise<Read<TmsHistoryRow[]>>;
  readDocuments(ctx: TmsContext, externalId: string): Promise<Read<TmsDocumentRow[]>>;
  readLineItems(ctx: TmsContext, externalId: string): Promise<Read<TmsLineItem[]>>;
  readParty(ctx: TmsContext, kind: TmsPartyKind, externalId: string): Promise<Read<TmsPartyRecord>>;
}
