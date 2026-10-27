import type { Param, Queryable } from "../../db";
import {
  readAdvanceInput,
  readCheckInput,
  readReceivablesInput,
  readSettlementInput,
} from "../../data/read";
import { customerOf, loadsOf } from "../../data/records";
import type {
  CustomerRow,
  LoadAccessorialRow,
  LoadRow,
  LoadStateMilesRow,
} from "../../data/rows";
import { assertIdentifier, TABLE_SPECS, type TenantTable } from "../../data/tables";
import { isUuid } from "../../uuid";
import type { TmsAdapter } from "../types";

// The TMS behind the app: today the seeded tables of this database. Reads only, each inside the
// caller's tenant transaction and naming its tenant, so a login that bypasses row-level security
// still reads one tenant. Writes nothing.

// The same column list and timestamp form src/lib/data/read.ts uses, so a row read here maps
// through the same record functions. `where` is SQL written in this file, never input.
function selectSql(table: TenantTable, where: string): string {
  const list = TABLE_SPECS[table].columns
    .map(([name, kind]) => {
      const col = assertIdentifier(name);
      if (kind === "timestamptz") {
        return `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${col}`;
      }
      if (kind === "jsonb") return `CAST(${col} AS text) AS ${col}`;
      return col;
    })
    .join(", ");
  const order = assertIdentifier(TABLE_SPECS[table].columns[0][0]);
  return (
    `SELECT ${list} FROM ${assertIdentifier(table)}` +
    ` WHERE tenant_id = current_tenant_id() AND ${where} ORDER BY ${order}`
  );
}

const LOAD_SQL = selectSql("loads", "id = CAST($1 AS uuid)");
const STATE_MILES_SQL = selectSql("load_state_miles", "load_id = CAST($1 AS uuid)");
const ACCESSORIALS_SQL = selectSql("load_accessorials", "load_id = CAST($1 AS uuid)");
const CUSTOMER_SQL = selectSql("customers", "id = CAST($1 AS uuid)");

function rows<T>(q: Queryable, sql: string, params: Param[]): Promise<T[]> {
  return q.query<T>(sql, params);
}

export const dbTmsAdapter: TmsAdapter = {
  settlementInput: (q, driverId, periodId) => readSettlementInput(q, driverId, periodId),
  advanceInput: (q, driverId, amountCents, requestedAt, loadId) =>
    readAdvanceInput(q, driverId, requestedAt, amountCents, loadId),
  checkInput: (q) => readCheckInput(q),
  receivablesInput: (q, asOf) => readReceivablesInput(q, asOf),

  // One load with its state miles, accessorials and customer, for an invoice. null when the load
  // is not this tenant's.
  async invoiceSource(q, loadId) {
    if (!isUuid(loadId)) throw new Error("loadId is not a uuid");
    const loads = await rows<LoadRow>(q, LOAD_SQL, [loadId]);
    if (loads.length === 0) return null;
    if (loads.length !== 1) throw new Error("more than one load");
    const miles = await rows<LoadStateMilesRow>(q, STATE_MILES_SQL, [loadId]);
    const extras = await rows<LoadAccessorialRow>(q, ACCESSORIALS_SQL, [loadId]);
    const [load] = loadsOf(loads, miles, extras);
    if (load.customerId === null) return { load, customer: null };
    const customers = await rows<CustomerRow>(q, CUSTOMER_SQL, [load.customerId]);
    if (customers.length > 1) throw new Error("more than one customer");
    return { load, customer: customers[0] ? customerOf(customers[0]) : null };
  },
};
