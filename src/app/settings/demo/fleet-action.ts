"use server";

import { revalidatePath } from "next/cache";
import { flags } from "@/config/flags";
import { requireStaff } from "@/lib/auth/role";
import { DbError } from "@/lib/db";
import { moveFleetIn } from "@/lib/loads/movement";
import { demoCarrierOf } from "@/lib/seed/reset";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

export type FleetCategory = "disabled" | "forbidden" | "not_demo" | "unreadable" | "unknown" | "failed";

export type FleetState =
  | { ok: true; pickedUp: number; delivered: number }
  | { ok: false; category: FleetCategory }
  | null;

class NotDemoCarrier extends Error {
  constructor() {
    super("not a demo carrier");
    this.name = "NotDemoCarrier";
  }
}

const UNREACHABLE: ReadonlySet<DbError["category"]> = new Set(["resuming", "unavailable", "timeout"]);

// "Move the fleet" on /settings/demo: the stand-in for a dispatch feed. A press moves at most three
// of a demo carrier's loads one step each (src/lib/loads/movement.ts moveFleetIn, source
// demo_feed), in one tenant transaction, leaving the hero driver's loads for the walk-through. Staff
// only, demo carriers only. No money moves and nothing is sent. Counts and categories only.
export async function moveFleetAction(): Promise<FleetState> {
  // The page's own switch, re-checked here before any read or write.
  if (!flags.demoResetEnabled) return { ok: false, category: "disabled" };
  try {
    const r = await withRequestTenant(async (q, session) => {
      await requireStaff(q, session);
      const carrier = await demoCarrierOf(q);
      if (!carrier) throw new NotDemoCarrier();
      let keep: string | null = null;
      if (carrier.heroCode) {
        const rows = await q.query<{ id: string }>(
          "SELECT CAST(id AS text) AS id FROM drivers WHERE tenant_id = current_tenant_id() AND code = $1",
          [carrier.heroCode],
        );
        keep = rows[0]?.id ?? null;
      }
      return moveFleetIn(q, new Date(), keep);
    });
    return { ok: true, pickedUp: r.pickedUp, delivered: r.delivered };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, category: "forbidden" };
    if (err instanceof NotDemoCarrier) return { ok: false, category: "not_demo" };
    if (err instanceof DbError) {
      console.error(`move the fleet: database ${err.category}${err.sqlState ? ` ${err.sqlState}` : ""}`);
      // A lost COMMIT reply: the moves may have landed, so never say nothing changed.
      if (err.category === "unknown") return { ok: false, category: "unknown" };
      return { ok: false, category: UNREACHABLE.has(err.category) ? "unreadable" : "failed" };
    }
    throw err;
  } finally {
    revalidatePath("/settings/demo");
  }
}
