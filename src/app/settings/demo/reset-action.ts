"use server";

import { revalidatePath } from "next/cache";
import { flags } from "@/config/flags";
import { DbError } from "@/lib/db";
import { DEMO_ANCHOR } from "@/lib/seed/anchor";
import { buildCarrierPlan } from "@/lib/seed/plan";
import {
  DemoResetFailed,
  DemoResetRefused,
  RESET_SQLSTATE,
  demoCarrierOf,
  refusalText,
  resetDemoInTransaction,
} from "@/lib/seed/reset";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

export type ResetCategory =
  | "disabled"
  | "unconfirmed"
  | "forbidden"
  | "not_demo"
  | "refused"
  | "failed"
  | "unknown"
  | "unreadable";

export type ResetState =
  | { ok: true; carrier: string; cleared: number; rewritten: number; heroNetCents: number | null }
  | { ok: false; category: ResetCategory; reasons?: string[] }
  | null;

// Only an outage, a resuming cluster or a timeout means the database could not be reached: the
// transaction rolls back, nothing changed, and the same reset may work in a moment. Any other
// database error (a constraint, a row security refusal, a missing setting) fails the same way
// every time, so it reads as a failed reset, never as an outage worth retrying.
// (Not exported: a "use server" file exports async actions only.)
const UNREACHABLE: ReadonlySet<DbError["category"]> = new Set(["resuming", "unavailable", "timeout"]);

function resetCategoryForDb(category: DbError["category"]): ResetCategory {
  return UNREACHABLE.has(category) ? "unreadable" : "failed";
}

class NotDemoCarrier extends Error {
  constructor() {
    super("not a demo carrier");
    this.name = "NotDemoCarrier";
  }
}

// The demo reset behind the button on /settings/demo: puts the session's own carrier back to its
// seeded week at the demo anchor, in ONE tenant transaction as the app role (src/lib/seed/reset.ts).
// Only an admin of a demo carrier may run it, only with the switch on and the box ticked. It
// returns counts and categories only, never database text; a refusal names its counts.
export async function resetDemoAction(_prev: ResetState, formData: FormData): Promise<ResetState> {
  // The page's own switch, re-checked here before any read or write.
  if (!flags.demoResetEnabled) return { ok: false, category: "disabled" };
  if (formData.get("confirm") !== "reset") return { ok: false, category: "unconfirmed" };
  try {
    // Signed out: withRequestTenant redirects to /sign-in, and that redirect is rethrown below.
    // The role, the carrier, the refusals, the clear, the replace and the read-back share the one
    // transaction, so a refusal or a failure at any step leaves the carrier as it was.
    const report = await withRequestTenant(async (q, session) => {
      const rows = await q.query<{ role: string }>(
        "SELECT role FROM memberships WHERE cognito_sub = $1",
        [session.sub],
      );
      if (rows.length !== 1 || rows[0].role !== "admin") throw new ForbiddenError();
      const carrier = await demoCarrierOf(q);
      if (!carrier) throw new NotDemoCarrier();
      return resetDemoInTransaction(q, buildCarrierPlan(carrier, DEMO_ANCHOR));
    });
    const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      ok: true,
      carrier: report.slug,
      cleared: sum(report.cleared),
      rewritten: sum(report.replaced.inserted),
      heroNetCents: report.heroNetCents,
    };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, category: "forbidden" };
    if (err instanceof NotDemoCarrier) return { ok: false, category: "not_demo" };
    if (err instanceof DemoResetRefused) {
      return { ok: false, category: "refused", reasons: err.refusals.map(refusalText) };
    }
    if (err instanceof DemoResetFailed) {
      console.error(`demo reset: failed (${err.message})`);
      return { ok: false, category: "failed" };
    }
    if (err instanceof DbError) {
      // The function's own guards, reached only if something changed after the reads above.
      if (err.sqlState === RESET_SQLSTATE.notDemo) return { ok: false, category: "not_demo" };
      if (err.sqlState === RESET_SQLSTATE.refused) return { ok: false, category: "refused" };
      // The category and the SQLSTATE only, never the error's text.
      console.error(`demo reset: database ${err.category}${err.sqlState ? ` ${err.sqlState}` : ""}`);
      // A failed commit: the reset may or may not have happened.
      if (err.category === "unknown") return { ok: false, category: "unknown" };
      return { ok: false, category: resetCategoryForDb(err.category) };
    }
    throw err;
  } finally {
    revalidatePath("/settings/demo");
  }
}
