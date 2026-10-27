import { GATEWAY_TABLES } from "../gateway/types";
import type { RefView } from "../view";

// Citing records (design 2.6): the loop never trusts a reference the model typed. A ref is kept
// only when its table is one the records know and its id came back in an allowed gateway result
// in this turn (or from the rules engine's own sources). Anything else is dropped here, and the
// chat renders any ref it cannot link as plain text.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLES: ReadonlySet<string> = new Set(GATEWAY_TABLES);

// Every id-shaped string anywhere in a tool result, lower-cased.
export function idsIn(value: unknown, into: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 12) return into;
  if (typeof value === "string") {
    if (UUID.test(value)) into.add(value.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const v of value) idsIn(v, into, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) idsIn(v, into, depth + 1);
  }
  return into;
}

export function validateRefs(refs: readonly RefView[], trusted: ReadonlySet<string>): RefView[] {
  const seen = new Set<string>();
  const out: RefView[] = [];
  for (const r of refs) {
    if (!r || typeof r.table !== "string" || typeof r.id !== "string") continue;
    if (!TABLES.has(r.table) || !UUID.test(r.id)) continue;
    const id = r.id.toLowerCase();
    if (!trusted.has(id)) continue;
    const key = `${r.table}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ table: r.table, id: r.id });
  }
  return out;
}
