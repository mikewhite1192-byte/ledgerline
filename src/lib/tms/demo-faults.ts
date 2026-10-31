import { flags } from "../../config/flags";
import { readDemoFaults, type DemoFault, type DemoFaults } from "../adapters/tms-source/faults";
import { DbError, type Queryable } from "../db";

// TMS-MIRROR (T3): the tenant's demo fault switches (tms_connections.demo_faults), as Settings >
// Demo reads and the faults route writes them, inside the caller's tenant transaction (RLS keeps
// every read and write to that tenant). Only a synthetic connection has them; anything else reads
// as none. The sync never reads this: only the synthetic feed acts on the switches.

export type FaultSettings =
  | { kind: "ok"; faults: DemoFaults }
  | { kind: "switched_off" }
  // No connection, or one that is not the synthetic feed.
  | { kind: "not_synthetic" };

type Row = { system: string; faults: string | null };

const READ_SQL = `SELECT system, CAST(demo_faults AS text) AS faults FROM tms_connections
  WHERE tenant_id = current_tenant_id()`;

function storedOf(text: string | null): DemoFaults {
  if (text === null) return readDemoFaults(null);
  try {
    return readDemoFaults(JSON.parse(text) as unknown);
  } catch {
    return readDemoFaults(null);
  }
}

export async function readFaultSettings(q: Queryable): Promise<FaultSettings> {
  if (flags.tmsSync.demoFaultsEnabled !== true) return { kind: "switched_off" };
  const rows = await q.query<Row>(READ_SQL);
  if (rows.length !== 1 || rows[0].system !== "synthetic") return { kind: "not_synthetic" };
  return { kind: "ok", faults: storedOf(rows[0].faults) };
}

// Merges a validated change (parseFaultChange) into the stored switches and writes all nine back,
// so the stored value only ever holds the known faults as booleans.
export async function saveDemoFaults(q: Queryable, change: Partial<Record<DemoFault, boolean>>): Promise<FaultSettings> {
  if (flags.tmsSync.demoFaultsEnabled !== true) return { kind: "switched_off" };
  const rows = await q.query<Row>(`${READ_SQL} FOR UPDATE`);
  if (rows.length !== 1 || rows[0].system !== "synthetic") return { kind: "not_synthetic" };
  const next: DemoFaults = { ...storedOf(rows[0].faults), ...change };
  const n = await q.execute(
    `UPDATE tms_connections SET demo_faults = CAST($1 AS jsonb)
      WHERE tenant_id = current_tenant_id() AND system = 'synthetic'`,
    [JSON.stringify(next)],
  );
  if (n !== 1) throw new DbError("unknown");
  return { kind: "ok", faults: next };
}
