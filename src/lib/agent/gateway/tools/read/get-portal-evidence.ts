import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { LIVE_STATUSES, latestEvidence, latestRun, portalReference } from "../../../../portal/views";
import { defineTool } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";

// Where a person starts a run. Fixed text: the tool never starts one, because a model turn can
// carry untrusted text and a run drives a browser and spends on model calls (design 4.1).
const START_ON = "Portal runs page (/portal-runs)";

// Reads what portal runs brought back for one load: the newest run's state and the newest
// evidence. It never starts, queues or changes a run.
export const getPortalEvidence = defineTool({
  name: "get_portal_evidence",
  description:
    "Read what the broker's portal runs found for one delivered load: the newest run's status " +
    "and the newest delivery check-in and check-out times and signed proof of delivery, if any. " +
    "It never starts a run; a person starts one on the Portal runs page. Times are in the " +
    "facility's zone.",
  tier: "read",
  roles: OPERATOR,
  label: "Reading portal evidence",
  args: z.strictObject({ loadId: idField() }),
  refs: (a) => [{ table: "loads", id: a.loadId }],
  run: async (q, ctx, a) => {
    if (!flags.portalRunnerEnabled) return { result: { status: "disabled" } };
    if ((await portalReference(q, a.loadId)) === null) return { result: { status: "not_on_portal" } };
    const run = await latestRun(q, a.loadId, ctx.now);
    if (!run) return { result: { status: "no_run", startOn: START_ON } };
    const e = await latestEvidence(q, a.loadId);
    const going = (LIVE_STATUSES as readonly string[]).includes(run.status) && !run.stalled;
    return {
      result: {
        status: run.status,
        runId: run.runId,
        ...(run.endedReason ? { endedReason: run.endedReason } : {}),
        ...(run.stalled ? { stalled: true } : {}),
        // Facts computed by code only. The model's own notes from the page are untrusted text
        // and are not returned here.
        evidence: e
          ? {
              runId: e.runId,
              deliveryCheckedIn: e.checkedIn,
              deliveryCheckedOut: e.checkedOut,
              timeZone: e.zoneLabel,
              minutesAtDock: e.minutesAtDock,
              pod: e.pod,
              readback: e.readback,
              screening: e.screenVerdict,
              ...(e.screenVerdict !== "clean" && e.untrustedInputId ? { flaggedInputId: e.untrustedInputId } : {}),
            }
          : null,
        // A run still going needs no second one; otherwise a person can start a fresh one.
        ...(going ? {} : { startOn: START_ON }),
      },
    };
  },
});
