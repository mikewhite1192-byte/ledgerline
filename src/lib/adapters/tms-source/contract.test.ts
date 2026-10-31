import { describe, expect, it } from "vitest";
import type { Queryable } from "../../db";
import { tmsSource, validated } from "./index";
import { createSyntheticSource } from "./synthetic";
import { TmsSourceError, type TmsConnection, type TmsContext, type TmsSource } from "./types";

// The contract every TMS source keeps, run against the synthetic feed (and any later adapter):
// a record that is not there reads gone, a fault throws a category, and an answer for the wrong
// id is malformed. Gone and unknown are never the same thing.

const CONNECTION: TmsConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  system: "synthetic",
  labelMap: {},
  lookbackHours: 4,
  finalizeCooloffMinutes: 30,
  feedFloorAt: null,
};

const LOAD_ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  load_number: "L-2001",
  status: "in_transit",
  pickup_on: "2026-11-02",
  delivered_at: null,
  loaded_miles: 500,
  linehaul_cents: 150_000,
  fuel_surcharge_cents: 0,
  pickup_arrived_at: null,
  pickup_departed_at: null,
  delivery_arrived_at: null,
  origin_city: "Springfield",
  origin_state: "IL",
  dest_city: "Riverton",
  dest_state: "OH",
  customer_code: "CUST-1",
  customer_name: "Example Freight Buyer",
  driver_external_id: "drv-1",
  truck_unit: "T-101",
  invoice_issued_on: null,
};

// The tenant's rows as the synthetic feed reads them; `fail` makes every read a database fault.
function ctxOf(opts: { fail?: boolean; loads?: unknown[] } = {}): TmsContext {
  const q: Queryable = {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (opts.fail) throw new Error("connection reset");
      if (sql.startsWith("SELECT slug FROM tenants")) return [{ slug: "demo-test" }] as T[];
      if (sql.includes("FROM load_accessorials")) return [] as T[];
      if (sql.includes("FROM loads l")) {
        const loads = (opts.loads ?? [LOAD_ROW]) as (typeof LOAD_ROW)[];
        return (sql.includes("l.load_number = $1") ? loads.filter((l) => l.load_number === params[0]) : loads) as T[];
      }
      if (sql.includes("FROM customers")) return [] as T[];
      if (sql.includes("FROM driver_identities")) return [] as T[];
      if (sql.includes("FROM drivers")) return [{ n: 0 }] as T[];
      throw new Error(`unexpected sql: ${sql.slice(0, 40)}`);
    },
    async execute() {
      throw new Error("a source never writes");
    },
  };
  return { tenantId: CONNECTION.id, zone: "America/Chicago", now: "2026-12-01T00:00:00.000Z", q, connection: CONNECTION };
}

const SOURCES: [string, () => TmsSource][] = [["synthetic", () => tmsSource(CONNECTION)]];

describe.each(SOURCES)("the TMS source contract: %s", (_name, make) => {
  it("reads a load that exists by its id", async () => {
    const r = await make().readLoad(ctxOf(), "syn:demo-test:L-2001");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.value.externalId).toBe("syn:demo-test:L-2001");
  });

  it("reads a deleted or unknown id as gone, on every read by id", async () => {
    const s = make();
    const ctx = ctxOf({ loads: [] });
    const id = "syn:demo-test:L-2001";
    expect(await s.readLoad(ctx, id)).toEqual({ kind: "gone" });
    expect(await s.readHistory(ctx, id, 0)).toEqual({ kind: "gone" });
    expect(await s.readDocuments(ctx, id)).toEqual({ kind: "gone" });
    expect(await s.readLineItems(ctx, id)).toEqual({ kind: "gone" });
    expect(await s.readLoad(ctxOf(), "syn:other-carrier:L-2001")).toEqual({ kind: "gone" });
  });

  it("throws a category on a fault, never gone and never a partial answer", async () => {
    const s = make();
    const ctx = ctxOf({ fail: true });
    for (const call of [
      () => s.readLoad(ctx, "syn:demo-test:L-2001"),
      () => s.readHistory(ctx, "syn:demo-test:L-2001", 0),
      () => s.listLoads(ctx, null, 10),
    ]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TmsSourceError);
      expect((err as TmsSourceError).category).toBe("server_error");
      expect((err as Error).message).not.toContain("connection reset");
    }
  });

  it("pages history from 0 until an empty page", async () => {
    const s = make();
    const first = await s.readHistory(ctxOf(), "syn:demo-test:L-2001", 0);
    const next = await s.readHistory(ctxOf(), "syn:demo-test:L-2001", 1);
    expect(first.kind === "ok" && first.value.length > 0).toBe(true);
    expect(next.kind === "ok" && next.value.length === 0).toBe(true);
  });
});

describe("the validating wrapper", () => {
  const base = createSyntheticSource();
  const ctx = ctxOf();

  it("turns an answer for another id into malformed", async () => {
    const liar: TmsSource = { ...base, readLoad: (c) => base.readLoad(c, "syn:demo-test:L-2001") };
    await expect(validated(liar).readLoad(ctx, "syn:demo-test:L-9999")).rejects.toMatchObject({ category: "malformed" });
  });

  it("turns a thrown error that is not a category into server_error", async () => {
    const broken: TmsSource = {
      ...base,
      readLoad: async () => {
        throw new Error("boom");
      },
    };
    await expect(validated(broken).readLoad(ctx, "x")).rejects.toMatchObject({ category: "server_error" });
  });

  it("refuses a system it has no adapter for", () => {
    expect(() => tmsSource({ system: "other" as "synthetic" })).toThrow();
  });
});
