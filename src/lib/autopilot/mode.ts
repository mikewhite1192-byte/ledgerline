import { flags } from "../../config/flags";
import type { Queryable } from "../db";
import { localDateOf } from "../time/local-date";
import { isPaused } from "./policy";
import { readPause, readRule, readZone } from "./read";

// What the autopilot would do with a new proposal of one kind, read inside the caller's tenant
// transaction: auto (it may approve it by itself, inside the owner's limits), ask (a person
// decides, so the desk asks them) or off (the owner turned the kind off: nobody is asked).
// Ask whenever the autopilot is off or unarmed, paused, the kind has no rule, the carrier's day is
// before the start date, or the kind is not one the autopilot may ever approve
// (flags.autopilot.kinds) or not armed there yet. A read that fails throws; the caller fails
// closed. Reads only.
export type AutopilotMode = "off" | "ask" | "auto";

export async function autopilotModeFor(q: Queryable, kind: string, nowMs: number = Date.now()): Promise<AutopilotMode> {
  const a = flags.autopilot;
  if (a.enabled !== true || a.armed !== true) return "ask";
  const rule = await readRule(q, kind, false);
  if (rule === null) return "ask";
  if (isPaused(await readPause(q), nowMs)) return "ask";
  // Before the carrier's local start date the autopilot approves nothing.
  if (localDateOf(new Date(nowMs).toISOString(), await readZone(q)) < a.startDate) return "ask";
  if (rule.mode === "off") return "off";
  const ceiling = Object.prototype.hasOwnProperty.call(a.kinds, kind) ? a.kinds[kind as keyof typeof a.kinds] : undefined;
  if (rule.mode === "auto" && ceiling?.armed === true) return "auto";
  return "ask";
}
