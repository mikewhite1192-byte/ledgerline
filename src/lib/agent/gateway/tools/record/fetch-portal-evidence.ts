import { z } from "zod";
import { createRunIn } from "../../../../portal/start";
import { kickPortalRun } from "../../../../portal/runner/kick";
import { defineTool } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";

// Asks for a load's delivery stamps and signed POD from the broker's portal (design 4.1). The
// tool only reads the portal and records a run; it never changes a load or moves money. A run
// takes about a minute, so the tool returns at once: the finished evidence when there is some,
// the live run when one is going, or a new queued run. The partial unique index on live runs is
// the dedupe key: the same ask twice is one run.
export const fetchPortalEvidence = defineTool({
  name: "fetch_portal_evidence",
  description:
    "Fetch one delivered load's delivery check-in and check-out times and its signed proof of " +
    "delivery from the broker's portal. Returns the finished evidence if there is some, the " +
    "status of a run that is still going, or starts a new run (about a minute). Set refresh to " +
    "true only when asked to fetch again. Times are in the facility's zone.",
  tier: "record",
  roles: OPERATOR,
  label: "Fetching portal evidence",
  args: z.strictObject({ loadId: idField(), refresh: z.boolean().optional() }),
  refs: (a) => [{ table: "loads", id: a.loadId }],
  run: async (q, ctx, a) => {
    const outcome = await createRunIn(q, ctx.session, { loadId: a.loadId, refresh: a.refresh === true, turnId: ctx.turnId }, ctx.now);
    switch (outcome.kind) {
      case "disabled":
        return { result: { started: false, reason: "disabled" } };
      case "no_portal_load":
        return { result: { started: false, reason: "not_on_portal" } };
      case "done": {
        const e = outcome.evidence;
        // Facts computed by code only. The model's own notes from the page are untrusted text
        // and are not returned here.
        return {
          result: {
            status: "done",
            runId: outcome.runId,
            evidence: {
              deliveryCheckedIn: e.checkedIn,
              deliveryCheckedOut: e.checkedOut,
              timeZone: e.zoneLabel,
              minutesAtDock: e.minutesAtDock,
              pod: e.pod,
              readback: e.readback,
              screening: e.screenVerdict,
              ...(e.screenVerdict !== "clean" && e.untrustedInputId ? { flaggedInputId: e.untrustedInputId } : {}),
            },
          },
        };
      }
      case "live":
        return { result: { status: outcome.status, runId: outcome.runId } };
      case "queued":
        // The worker starts after this transaction commits; it waits for the row to appear.
        kickPortalRun({ tenantId: ctx.session.tenantId, runId: outcome.runId });
        return { result: { status: "queued", runId: outcome.runId } };
    }
  },
});
