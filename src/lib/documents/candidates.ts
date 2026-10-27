import type { Queryable } from "../db";
import { readRowsWhereId, readTable, readTenant } from "../data/read";
import type { FuelPurchaseRow, PayItemRow } from "../data/rows";
import { norm, type Candidates } from "./match";
import type { DocumentRead } from "./types";

// The records a reading could match, read inside the caller's tenant transaction through the
// record readers (row-level security scopes every read). Load and truck unit are found by whole
// value; nothing is searched by a part of a string.

export async function loadCandidates(q: Queryable, read: DocumentRead): Promise<Candidates> {
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant for the transaction");
  const loadNumber = norm(read.fields.loadNumber);
  const truckUnit = norm(read.fields.truckUnit);

  const loads = loadNumber === null ? [] : (await readTable(q, "loads")).filter((l) => norm(l.load_number) === loadNumber);
  const load = loads.length === 1 ? loads[0] : null;
  const drivers = await readTable(q, "drivers");
  const truckDrivers = truckUnit === null ? [] : drivers.filter((d) => norm(d.truck_unit) === truckUnit);
  const loadDriver = load?.driver_id ? (drivers.find((d) => d.id === load.driver_id) ?? null) : null;
  const customer = load ? ((await readRowsWhereId(q, "customers", "id", load.customer_id))[0] ?? null) : null;
  const accessorials = load ? await readRowsWhereId(q, "load_accessorials", "load_id", load.id) : [];

  const driverIds = [...new Set([...(loadDriver ? [loadDriver.id] : []), ...truckDrivers.map((d) => d.id)])];
  const payItems: PayItemRow[] = [];
  const fuelPurchases: FuelPurchaseRow[] = [];
  for (const id of driverIds) {
    payItems.push(...(await readRowsWhereId(q, "pay_items", "driver_id", id)));
    fuelPurchases.push(...(await readRowsWhereId(q, "fuel_purchases", "driver_id", id)));
  }
  return {
    timeZone: tenant.timezone,
    load,
    loadMatches: loads.length,
    customer,
    loadDriver,
    accessorials,
    truckDrivers,
    payItems,
    fuelPurchases,
  };
}
