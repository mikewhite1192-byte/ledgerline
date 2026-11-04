"use server";

import { flags } from "@/config/flags";
import { markCopyReady } from "@/lib/auth/demo-visit";
import { getPreparingVisit, visitLanding } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { demoCarrierOf } from "@/lib/seed/reset";
import { buildCopySlice } from "@/lib/visit-copy/build";
import { purgeExpired } from "@/lib/visit-copy/purge";
import { startCopySweep } from "@/lib/visit-copy/story";

// One slice of a visit's own copy of the demo carrier (src/lib/visit-copy/build.ts), called by the
// preparing page until the copy is ready. A visitor has no session while the copy is being built,
// so there is no staff check to make: the gate is the visit itself, read the way every request
// reads it (src/lib/auth/session.ts getPreparingVisit: a judge's live visit in the demo carrier,
// its copy claimed by the sign-in, not built and not purged). Anything else gets where the request
// belongs instead, with nothing written. The demo carrier the copy is built from is the visit's
// own carrier, matched exactly (a copy is never copied). The build writes only the copy's own
// carrier, under its own tenant; then, in the demo carrier, only the visit's copy_ready_at. The
// slice that writes the copy's setup rows also purges up to flags.visitCopies.purgePerCall copies
// of ended visits. Once the copy is marked ready, its own pay check starts while its switch is on
// (src/lib/visit-copy/story.ts, which never throws): the answer is ready whatever it did. The log
// gets counts and the error's name only.

export type BuildState =
  | { state: "building"; tablesDone: number; tablesTotal: number }
  | { state: "ready" }
  | { state: "leave"; to: string }
  | { state: "failed" };

export async function buildCopyAction(): Promise<BuildState> {
  if (!flags.visitCopies.enabled) return { state: "leave", to: "/" };
  const visit = await getPreparingVisit();
  if (!visit) return { state: "leave", to: await visitLanding() };
  const db = getDb();
  const home = visit.token.tenantId;
  try {
    const template = await db.withTenant(home, (q) => demoCarrierOf(q));
    if (!template) {
      console.error("visit copy: the visit's carrier is not a demo carrier");
      return { state: "failed" };
    }
    const report = await buildCopySlice(
      db,
      {
        ticketId: visit.ticketId,
        copyTenantId: visit.copy.tenantId,
        copySessionId: visit.copy.sessionId,
        expiresAt: visit.copy.expiresAt,
        template,
      },
      { sliceMs: flags.visitCopies.sliceMs },
    );
    console.info(
      `visit copy: slice ${report.tablesDone}/${report.tablesTotal} tables, ${report.statements} statements, ${report.ms} ms`,
    );
    if (report.setup) {
      const purged = await purgeExpired(db, home, {
        graceMinutes: flags.visitCopies.graceMinutes,
        limit: flags.visitCopies.purgePerCall,
      }).catch((err: unknown) => {
        console.error(`visit copy: the purge could not run (${err instanceof Error ? err.name : "non-error"})`);
        return null;
      });
      if (purged) console.info(`visit copy: purged ${purged.purged}, gone ${purged.gone}, failed ${purged.failed}`);
    }
    if (!report.done) return { state: "building", tablesDone: report.tablesDone, tablesTotal: report.tablesTotal };
    const ready = await db.withTenant(home, (q) =>
      markCopyReady(q, { visitId: visit.ticketId, sub: visit.token.sub, copyTenantId: visit.copy.tenantId }),
    );
    if (!ready) {
      console.error("visit copy: the visit could not be marked ready");
      return { state: "failed" };
    }
    console.info("visit copy: ready");
    await startWithin(startCopySweep(db, visit), STORY_START_MS);
    return { state: "ready" };
  } catch (err) {
    console.error(`visit copy: a slice failed (${err instanceof Error ? err.name : "non-error"})`);
    return { state: "failed" };
  }
}

// The copy's pay check start may take this long before the visit is told it is ready anyway; a
// start still going on is left to finish or fail on its own, and Home reads back what it made.
const STORY_START_MS = 5_000;

async function startWithin(start: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  const won = await Promise.race([start.then(() => "done" as const, () => "done" as const), late]);
  clearTimeout(timer);
  if (won === "late") console.info("visit copy: sweep skipped timed_out");
}
