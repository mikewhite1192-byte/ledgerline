import type { LoadEventRow, LoadRow } from "../data/rows";
import { instantAt } from "./calendar";
import { Rng } from "./prng";

// The seed's moves (0071): one load_events row per status change in its history, source seed,
// naming no evidence, from their own id stream (`<seed>:events`) so no other row's id moves. A load
// past planned was picked up (at its pickup departure, else 08:00 in the carrier's zone on its
// pickup date); a delivered or invoiced load was also delivered (at its delivered_at). Invoicing is
// not a move: load_events records planned to in transit and in transit to delivered only.
export function buildLoadEvents(input: { seed: string; zone: string; loads: readonly LoadRow[] }): LoadEventRow[] {
  const rng = new Rng(`${input.seed}:events`);
  const out: LoadEventRow[] = [];
  const ordered = [...input.loads].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const load of ordered) {
    if (load.status === "planned" || load.status === "cancelled") continue;
    out.push({
      id: rng.uuid(),
      load_id: load.id,
      from_status: "planned",
      to_status: "in_transit",
      source: "seed",
      evidence_table: null,
      evidence_id: null,
      at: load.pickup_departed_at ?? instantAt(load.pickup_on, 8, 0, input.zone),
    });
    if (load.status === "in_transit") continue;
    if (load.delivered_at === null) throw new Error("a delivered seed load has no delivered_at");
    out.push({
      id: rng.uuid(),
      load_id: load.id,
      from_status: "in_transit",
      to_status: "delivered",
      source: "seed",
      evidence_table: null,
      evidence_id: null,
      at: load.delivered_at,
    });
  }
  return out;
}
