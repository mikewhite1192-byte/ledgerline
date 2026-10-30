import type { Queryable } from "../db";
import { LOAD_NUMBER_PAGING, readLoadNumbers, readRowsWhereId, readTable, readTenant, type Paging } from "../data/read";
import type { FuelPurchaseRow, LoadRow, PayItemRow } from "../data/rows";
import { norm, type Candidates } from "./match";
import type { DocumentRead } from "./types";

// The records a reading could match, read inside the caller's tenant transaction through the
// record readers (row-level security scopes every read). Load and truck unit are found by whole
// value; nothing is searched by a part of a string. Loads are found from the paged read of ids
// and load numbers, so no statement's answer nears the Data API's 1 MiB cap however many loads
// the carrier holds; a read that stops at its bound throws, never a partial set of loads.

export async function loadCandidates(
  q: Queryable,
  read: DocumentRead,
  paging: Paging = LOAD_NUMBER_PAGING,
): Promise<Candidates> {
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant for the transaction");
  const loadNumber = norm(read.fields.loadNumber);
  const truckUnit = norm(read.fields.truckUnit);

  const loadIds =
    loadNumber === null
      ? []
      : (await readLoadNumbers(q, paging)).filter((l) => norm(l.load_number) === loadNumber).map((l) => l.id);
  const load = loadIds.length === 1 ? await matchedLoad(q, loadIds[0], loadNumber) : null;
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
    loadMatches: loadIds.length,
    customer,
    loadDriver,
    accessorials,
    truckDrivers,
    payItems,
    fuelPurchases,
  };
}

// The one load the number matched, read whole by its id. Anything but one row that still holds
// that number (the load vanished, its id came back twice, or its number changed between the two
// reads) fails the read: it is never taken as no match.
async function matchedLoad(q: Queryable, id: string, loadNumber: string | null): Promise<LoadRow> {
  const rows = await readRowsWhereId(q, "loads", "id", id);
  if (rows.length !== 1 || norm(rows[0].load_number) !== loadNumber) {
    throw new Error("the matched load is not one row");
  }
  return rows[0];
}
