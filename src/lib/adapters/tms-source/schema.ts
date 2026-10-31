import { z } from "zod";
import { isLocalClock } from "../../tms/clocks";
import { parseInstant } from "../../time/local-date";
import {
  TmsSourceError,
  type ListBookmark,
  type Read,
  type TmsDocumentRow,
  type TmsHistoryRow,
  type TmsLineItem,
  type TmsListRow,
  type TmsLoadRecord,
  type TmsPartyRecord,
} from "./types";

// TMS-MIRROR: every body a TMS source returns is checked here before our code reads it. Strict
// objects (a field we do not know, a file address among them, fails), integer cents, bounded
// strings: ids 1 to 64, names 1 to 120, labels 1 to 60, changedBy 0 to 80. One field that fails
// makes the whole record malformed: unknown, never partial.

const MAX_CENTS = 2_000_000_000;

const instant = z.string().refine((v) => {
  try {
    parseInstant(v);
    return true;
  } catch {
    return false;
  }
});
const id = z.string().min(1).max(64);
const name = z.string().min(1).max(120);
const label = z.string().min(1).max(60);
const short = z.string().min(1).max(40);
const localClock = z.string().refine(isLocalClock);
const cents = z.number().int().min(-MAX_CENTS).max(MAX_CENTS);
const count = z.number().int().min(0).max(1000);

const twoClocks = z.strictObject({ utc: instant.nullable(), local: localClock });

const bookmark = z.strictObject({ createdAt: instant, id });

const listRow = z.strictObject({
  externalId: id,
  createdAt: instant,
  updatedAt: instant,
  statusLabel: label,
  reference: id.nullable(),
  driverExternalId: id.nullable(),
});

const stop = z.strictObject({
  name,
  city: name,
  state: short,
  apptFromLocal: localClock.nullable(),
  apptToLocal: localClock.nullable(),
  arrived: twoClocks.nullable(),
  completed: twoClocks.nullable(),
});

const loadRecord = z.strictObject({
  externalId: id,
  reference: id,
  statusLabel: label,
  customer: z.strictObject({ externalId: id, name }).nullable(),
  driverExternalId: id.nullable(),
  truckUnit: short.nullable(),
  trailerUnit: short.nullable(),
  vin: short.nullable(),
  pickups: z.array(stop).max(50),
  deliveries: z.array(stop).max(50),
  stopCount: count,
  legCount: count,
  pickedUp: twoClocks.nullable(),
  delivered: twoClocks.nullable(),
  lastDeliveryCompleted: twoClocks.nullable(),
  revenueTotalCents: cents.nullable(),
  driverPayTotalCents: cents.nullable(),
  updatedAt: instant,
  finalizedAt: instant.nullable(),
});

const historyRow = z.strictObject({
  externalId: id,
  field: label,
  newValue: name.nullable(),
  previousValue: name.nullable(),
  changedBy: z.string().max(80).nullable(),
  at: twoClocks,
});

const documentRow = z.strictObject({
  externalId: id,
  fileName: name,
  typeLabel: label,
  shared: z.boolean(),
  updatedAt: instant,
  byteLength: z.number().int().min(0).max(100_000_000),
  uploaderKind: z.enum(["driver_app", "office", "unknown"]),
});

const lineItem = z.strictObject({
  externalId: id,
  group: z.enum(["revenue", "driver_pay", "accessorial"]),
  typeLabel: label,
  description: z.string().max(120),
  amountCents: cents,
});

const party = z.strictObject({
  partyKind: z.enum(["customer", "driver", "truck", "trailer"]),
  externalId: id,
  name,
  unit: short.nullable(),
  vin: short.nullable(),
});

const MAX_ROWS = 500;

function check<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new TmsSourceError("malformed");
  return r.data;
}

function readOf<T>(schema: z.ZodType<T>, value: unknown): Read<T> {
  if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "gone") {
    return check(z.strictObject({ kind: z.literal("gone") }), value) as Read<T>;
  }
  const r = check(z.strictObject({ kind: z.literal("ok"), value: z.unknown(), asOf: instant }), value);
  return { kind: "ok", value: check(schema, r.value), asOf: r.asOf };
}

export function parseListPage(value: unknown): { rows: TmsListRow[]; next: ListBookmark | null } {
  return check(z.strictObject({ rows: z.array(listRow).max(MAX_ROWS), next: bookmark.nullable() }), value);
}
export const parseLoadRead = (v: unknown): Read<TmsLoadRecord> => readOf(loadRecord, v);
export const parseHistoryRead = (v: unknown): Read<TmsHistoryRow[]> => readOf(z.array(historyRow).max(MAX_ROWS), v);
export const parseDocumentsRead = (v: unknown): Read<TmsDocumentRow[]> => readOf(z.array(documentRow).max(MAX_ROWS), v);
export const parseLineItemsRead = (v: unknown): Read<TmsLineItem[]> => readOf(z.array(lineItem).max(MAX_ROWS), v);
export const parsePartyRead = (v: unknown): Read<TmsPartyRecord> => readOf(party, v);
export const parseReady = (v: unknown) =>
  check(
    z.union([
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({
        ok: z.literal(false),
        category: z.enum(["unreachable", "unauthorized", "rate_limited", "malformed", "server_error", "timeout"]),
      }),
    ]),
    v,
  );
