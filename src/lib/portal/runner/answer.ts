import { z } from "zod";
import { instantOf, isFacilityZone, labelOf, ZONE_LABELS, zoneOf, type FacilityZone } from "../zones";

// The model's final answer and what code makes of it (design 3.5). The model reads the page; code
// decides the facts: the times become instants in the zone the label names, the POD counts only
// when the browser captured a PDF, and the portal's own record is compared afterwards.

export const NOTES_MAX = 300;
const ANSWER_TEXT_MAX = 4_000;
const WALL = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$/;
const wall = z.string().regex(WALL).nullable();

export const answerSchema = z.strictObject({
  found: z.boolean(),
  reference: z.string().regex(/^FFE-[0-9]{6}$/),
  deliveryCheckedIn: wall,
  deliveryCheckedOut: wall,
  timeZoneLabel: z.enum(ZONE_LABELS).nullable(),
  podDownloaded: z.boolean(),
  podSignedBy: z.string().max(80).nullable(),
  notes: z.string().max(NOTES_MAX),
});
export type PortalAnswer = z.infer<typeof answerSchema>;

export type ReadAnswer =
  | {
      ok: true;
      answer: PortalAnswer;
      checkedIn: string | null;
      checkedOut: string | null;
      zone: FacilityZone | null;
    }
  | { ok: false };

// The answer text is one JSON object. A single code fence around it is tolerated; anything else
// around it is not.
function jsonOf(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    return undefined;
  }
}

// Strict: a miss anywhere is no evidence. The reference must be the run's own, whole.
export function readAnswer(text: string, reference: string): ReadAnswer {
  if (typeof text !== "string" || text.length === 0 || text.length > ANSWER_TEXT_MAX) return { ok: false };
  const parsed = answerSchema.safeParse(jsonOf(text));
  if (!parsed.success) return { ok: false };
  const answer = parsed.data;
  if (answer.reference !== reference) return { ok: false };
  const { deliveryCheckedIn: inWall, deliveryCheckedOut: outWall, timeZoneLabel: label } = answer;
  if (inWall === null && outWall === null) {
    return { ok: true, answer, checkedIn: null, checkedOut: null, zone: null };
  }
  // One time without the other, times without a zone, or times on a load the model says it did
  // not find: not evidence.
  if (inWall === null || outWall === null || label === null || !answer.found) return { ok: false };
  const zone = zoneOf(label);
  const checkedIn = instantOf(inWall, zone);
  const checkedOut = instantOf(outWall, zone);
  if (!checkedIn || !checkedOut) return { ok: false };
  if (Date.parse(checkedOut) < Date.parse(checkedIn)) return { ok: false };
  return { ok: true, answer, checkedIn, checkedOut, zone };
}

export type PortalRecord = {
  checkedIn: string | null;
  checkedOut: string | null;
  zone: string;
  podContentHash: string | null;
};

export type Readback = "matches" | "differs" | "partial";

const minute = (instant: string) => Math.floor(Date.parse(instant) / 60_000);

// The answer and the captured POD against the portal's own row, which only this demo can do
// because the portal is ours. Shown in the trace and counted by EVAL; never the evidence value.
//   matches: every fact the portal holds was read back the same, and nothing extra was claimed;
//   differs: a time, the zone or the POD bytes disagree, or the answer claims what the portal
//            does not hold;
//   partial: nothing disagrees, but something the portal holds was not read back.
export function readbackOf(
  read: { checkedIn: string | null; checkedOut: string | null; zone: FacilityZone | null; podHash: string | null },
  record: PortalRecord,
): Readback {
  const results: Readback[] = [];
  if (record.checkedIn && record.checkedOut) {
    if (!read.checkedIn || !read.checkedOut) results.push("partial");
    else {
      const same =
        minute(read.checkedIn) === minute(record.checkedIn) &&
        minute(read.checkedOut) === minute(record.checkedOut) &&
        isFacilityZone(record.zone) &&
        read.zone !== null &&
        labelOf(read.zone) === labelOf(record.zone);
      results.push(same ? "matches" : "differs");
    }
  } else {
    results.push(read.checkedIn ? "differs" : "matches");
  }
  if (record.podContentHash) {
    if (!read.podHash) results.push("partial");
    else results.push(read.podHash === record.podContentHash ? "matches" : "differs");
  } else {
    results.push(read.podHash ? "differs" : "matches");
  }
  if (results.includes("differs")) return "differs";
  return results.includes("partial") ? "partial" : "matches";
}

// Minutes between check-in and check-out, by code, for the evidence card.
export function minutesAtDock(checkedIn: string | null, checkedOut: string | null): number | null {
  if (!checkedIn || !checkedOut) return null;
  return minute(checkedOut) - minute(checkedIn);
}
