import { flags } from "../../config/flags";

// The driver admin switch (flags.driverAdmin), read fresh on every call (never cached), so a switch
// turned off stops the next request. The Add driver page, its route and the service each ask it.
export function driverAdminOn(): boolean {
  return flags.driverAdmin?.enabled === true;
}
