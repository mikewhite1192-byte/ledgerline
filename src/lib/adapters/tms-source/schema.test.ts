import { describe, expect, it } from "vitest";
import { parseDocumentsRead, parseHistoryRead, parseLineItemsRead, parseListPage, parseLoadRead } from "./schema";

const AS_OF = "2026-11-02T20:00:00.000Z";
const ok = (value: unknown) => ({ kind: "ok", value, asOf: AS_OF });

const RECORD = {
  externalId: "syn:x:L-1",
  reference: "L-1",
  statusLabel: "Delivered",
  customer: { externalId: "CUST-1", name: "Example Freight Buyer" },
  driverExternalId: "drv-1",
  truckUnit: "T-101",
  trailerUnit: null,
  vin: null,
  pickups: [],
  deliveries: [],
  stopCount: 2,
  legCount: 1,
  pickedUp: null,
  delivered: { utc: "2026-11-02T20:14:00.000Z", local: "2026-11-02T14:14" },
  lastDeliveryCompleted: null,
  revenueTotalCents: 150_000,
  driverPayTotalCents: null,
  updatedAt: AS_OF,
  finalizedAt: null,
};

const malformed = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ category: "malformed" }));

describe("TMS bodies are checked before our code reads them", () => {
  it("accepts a clean record", () => {
    expect(parseLoadRead(ok(RECORD)).kind).toBe("ok");
    expect(parseLoadRead({ kind: "gone" })).toEqual({ kind: "gone" });
  });

  it("rejects a file address or any field it does not know", () => {
    malformed(() => parseLoadRead(ok({ ...RECORD, podUrl: "https://files.example/pod.jpg" })));
    malformed(() =>
      parseDocumentsRead(
        ok([
          {
            externalId: "d1",
            fileName: "pod.jpg",
            typeLabel: "POD",
            shared: true,
            updatedAt: AS_OF,
            byteLength: 10,
            uploaderKind: "driver_app",
            url: "https://files.example/signed",
          },
        ]),
      ),
    );
  });

  it("rejects a cent that is not an integer", () => {
    malformed(() => parseLoadRead(ok({ ...RECORD, revenueTotalCents: 1500.5 })));
    malformed(() =>
      parseLineItemsRead(ok([{ externalId: "l1", group: "revenue", typeLabel: "Linehaul", description: "x", amountCents: 0.1 }])),
    );
  });

  it("rejects a label over 60 characters and an id over 64", () => {
    malformed(() => parseLoadRead(ok({ ...RECORD, statusLabel: "x".repeat(61) })));
    expect(parseLoadRead(ok({ ...RECORD, statusLabel: "x".repeat(60) })).kind).toBe("ok");
    malformed(() => parseLoadRead(ok({ ...RECORD, externalId: "x".repeat(65) })));
  });

  it("rejects a local clock that is not a wall time and a changedBy over 80", () => {
    malformed(() => parseLoadRead(ok({ ...RECORD, delivered: { utc: null, local: "11/02/2026 2:14 PM" } })));
    const row = {
      externalId: "h1",
      field: "status",
      newValue: "Delivered",
      previousValue: null,
      changedBy: "y".repeat(81),
      at: { utc: null, local: "2026-11-02T14:14" },
    };
    malformed(() => parseHistoryRead(ok([row])));
    expect(parseHistoryRead(ok([{ ...row, changedBy: "" }])).kind).toBe("ok");
  });

  it("rejects one bad row as the whole page, never a partial page", () => {
    const good = { externalId: "a", createdAt: AS_OF, updatedAt: AS_OF, statusLabel: "New", reference: null, driverExternalId: null };
    expect(parseListPage({ rows: [good], next: null }).rows).toHaveLength(1);
    malformed(() => parseListPage({ rows: [good, { ...good, statusLabel: "" }], next: null }));
  });
});
