import { createHash } from "node:crypto";
import { isUuid } from "../uuid";

// A visit's copy of a demo carrier is the template's seed plan with every id swapped for one of the
// copy's own. Every row of the plan has a uuid primary key that is unique across the database, so
// a second carrier built from the same plan needs fresh ids, and every foreign key, every id held
// in a jsonb column (settlement lines' sources, dispatch flags) and every id held in a text column
// must move with the row it names. The walk replaces each string that is a whole uuid, wherever it
// sits, with copyUuid(copyId, value): the same input always gives the same output, so references
// stay joined, and two copies never share an id. A uuid inside a longer string is left alone; the
// seed writes none (src/lib/visit-copy/remap.test.ts and the copy build's database test prove the
// plan holds no id that points outside it).

// The copy's id for a template id: the first 16 bytes of sha256(copyId ":" id), shaped as a
// version 4 uuid. Both inputs are lowercased first, so case never makes a second id.
export function copyUuid(copyId: string, id: string): string {
  const h = createHash("sha256").update(`${copyId.toLowerCase()}:${id.toLowerCase()}`, "utf8").digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// A deep copy of value with every whole-uuid string, as a value or as an object key, replaced.
// Arrays and plain objects are walked; numbers, booleans, null and other strings are kept as they
// are. Anything else (a Date, a Map, a class instance) is refused, so nothing is copied by
// reference and missed.
export function remapPlanIds<T>(value: T, copyId: string): T {
  if (!isUuid(copyId)) throw new Error("the copy id is not a uuid");
  const memo = new Map<string, string>();
  const swap = (s: string): string => {
    if (!isUuid(s)) return s;
    let out = memo.get(s);
    if (out === undefined) {
      out = copyUuid(copyId, s);
      memo.set(s, out);
    }
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return swap(v);
    if (v === null || typeof v === "number" || typeof v === "boolean" || v === undefined) return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[swap(k)] = walk(inner);
      return out;
    }
    throw new Error("the plan holds a value the copy cannot walk");
  };
  return walk(value) as T;
}
