import { describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import {
  EMPTY_PACKET,
  PACKET_DOCUMENTS_SQL,
  PACKET_INVOICES_SQL,
  PACKET_PODS_SQL,
  packetComplete,
  packetFromJson,
  packetGaps,
  packetOf,
  packetsOf,
} from "./packet";

// The papers sent with each factored invoice, read from a fake database that answers the three
// reads by name. Ids only; no file contents and no names.

const id = (n: number) => `5e7c2a10-4b3d-4f6e-8a9b-${String(n).padStart(12, "0")}`;
const INV_A = id(1);
const INV_B = id(2);
const INV_OPENING = id(3);
const LOAD_A = id(11);
const LOAD_B = id(12);
const RC_NEW = id(21);
const RC_OLD = id(22);
const BOL = id(23);
const RUN = id(31);

type Call = { sql: string; params: unknown[] };

function fakeDb(): { q: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  const q = {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      calls.push({ sql, params });
      const list = JSON.parse(String(params[0])) as string[];
      if (sql === PACKET_INVOICES_SQL) {
        const rows = [
          { id: INV_A, load_id: LOAD_A },
          { id: INV_B, load_id: LOAD_B },
          { id: INV_OPENING, load_id: null },
        ];
        return rows.filter((r) => list.includes(r.id)) as T[];
      }
      if (sql === PACKET_DOCUMENTS_SQL) {
        // Newest first, as the read orders them.
        const rows = [
          { load_id: LOAD_A, document_kind: "rate_confirmation", id: RC_NEW },
          { load_id: LOAD_A, document_kind: "rate_confirmation", id: RC_OLD },
          { load_id: LOAD_A, document_kind: "bill_of_lading", id: BOL },
          { load_id: LOAD_B, document_kind: "rate_confirmation", id: "not-a-uuid" },
        ];
        return rows.filter((r) => list.includes(r.load_id)) as T[];
      }
      if (sql === PACKET_PODS_SQL) {
        return [{ load_id: LOAD_A, run_id: RUN }].filter((r) => list.includes(r.load_id)) as T[];
      }
      throw new Error("unexpected read");
    },
  } as unknown as Queryable;
  return { q, calls };
}

describe("packetsOf", () => {
  it("finds the newest paper of each kind for each invoice's load, and a clean POD from a portal run", async () => {
    const { q } = fakeDb();
    const packets = await packetsOf(q, [INV_A, INV_B]);
    expect(packets.get(INV_A)).toEqual({
      invoice: true,
      rateConfirmation: { onFile: true, documentId: RC_NEW },
      billOfLading: { onFile: true, documentId: BOL },
      pod: { onFile: true, portalRunId: RUN },
    });
    // A paper whose id is not a real id is not on file.
    expect(packets.get(INV_B)).toEqual(EMPTY_PACKET);
  });

  it("gives an invoice with no load only itself, without reading papers", async () => {
    const { q, calls } = fakeDb();
    expect(await packetOf(q, INV_OPENING)).toEqual(EMPTY_PACKET);
    expect(calls.map((c) => c.sql)).toEqual([PACKET_INVOICES_SQL]);
  });

  it("reads nothing for ids that are not real ids, and leaves out an invoice that is not here", async () => {
    const { q, calls } = fakeDb();
    expect((await packetsOf(q, ["BR-INV-1", "' OR 1=1"])).size).toBe(0);
    expect(calls).toEqual([]);
    expect(await packetOf(q, id(99))).toBeNull();
  });

  it("passes the ids as one list parameter, never in the statement", async () => {
    const { q, calls } = fakeDb();
    await packetsOf(q, [INV_A]);
    expect(calls[0].params).toEqual([JSON.stringify([INV_A])]);
    expect(calls.every((c) => !c.sql.includes(INV_A))).toBe(true);
  });
});

describe("packet checks", () => {
  const full = {
    invoice: true as const,
    rateConfirmation: { onFile: true, documentId: RC_NEW },
    billOfLading: { onFile: true, documentId: BOL },
    pod: { onFile: true, portalRunId: RUN },
  };

  it("is complete only with all three papers on file", () => {
    expect(packetComplete(full)).toBe(true);
    expect(packetGaps(full)).toEqual([]);
    expect(packetComplete({ ...full, pod: { onFile: false, portalRunId: null } })).toBe(false);
    expect(packetGaps(EMPTY_PACKET)).toEqual(["rate_confirmation", "bill_of_lading", "pod"]);
  });

  it("reads a stored snapshot back whole, and anything else as nothing on file", () => {
    expect(packetFromJson(JSON.parse(JSON.stringify(full)))).toEqual(full);
    expect(packetFromJson(null)).toEqual(EMPTY_PACKET);
    expect(packetFromJson("packet")).toEqual(EMPTY_PACKET);
    // On file with no real id, or a real id not marked on file, is not on file.
    expect(packetFromJson({ ...full, billOfLading: { onFile: true, documentId: "x" } }).billOfLading).toEqual({
      onFile: false,
      documentId: null,
    });
    expect(packetFromJson({ ...full, pod: { onFile: "yes", portalRunId: RUN } }).pod).toEqual({ onFile: false, portalRunId: null });
  });
});
