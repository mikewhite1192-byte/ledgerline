import { flags } from "@/config/flags";
import { todayStartIso } from "@/lib/autopilot/read";
import { readRules } from "@/lib/autopilot/rules-admin";
import { DbError, type Queryable } from "@/lib/db";
import { readFeedHeader } from "@/lib/feed/read";
import { loaded, wholeNumber, type Loaded } from "@/lib/home/loaded";
import { readBoard } from "@/lib/mock-tms/store";
import { demoCarrierOf } from "@/lib/seed/reset";
import { withRequestTenant } from "@/lib/tenant/context";
import { addDays, type LocalDate } from "@/lib/time/local-date";

// The walkthrough's own reads, past the ones Home already makes: the morning digest's stored line,
// the desk's last check-in and what it finished today, the autopilot's rules and pause, and the
// sample dispatch board's loads. Each runs in its own carrier transaction through loaded(), so one
// that fails makes its step say so and leaves the rest of the panel and of Home alone. Reads only:
// no model call, nothing written.

// How far back a stored digest line still counts as the morning's: today and the two days before.
export const DIGEST_DAYS = 3;

export type DeskFacts = { checkedAt: string | null; doneToday: number };
// What runs on Auto right now (armed, allowed, the rule set to Auto), each with its most per item.
export type AutopilotFacts = {
  on: boolean;
  paused: boolean;
  pausedAt: string | null;
  auto: { kind: string; maxCents: number }[];
};

export type TourFacts = {
  // The newest digest line within DIGEST_DAYS, or null when there is none (or the digest is off).
  digest: Loaded<string | null>;
  desk: Loaded<DeskFacts>;
  // null while the autopilot rules page is off, so the step is not shown.
  autopilot: Loaded<AutopilotFacts> | null;
  // null while the sample dispatch system is off; a value of null when this carrier has no board.
  board: Loaded<number | null> | null;
};

const DIGEST_SQL = `SELECT text FROM agent_asks
  WHERE tenant_id = current_tenant_id() AND kind = 'digest' AND period_date >= CAST($1 AS date)
  ORDER BY period_date DESC LIMIT 1`;

const DONE_SQL = `SELECT CAST(count(*) AS integer) AS n FROM desk_log
  WHERE tenant_id = current_tenant_id() AND kind = 'done' AND at >= CAST($1 AS timestamptz)`;

export async function readDigestLine(q: Queryable, today: LocalDate): Promise<string | null> {
  const rows = await q.query<{ text: unknown }>(DIGEST_SQL, [addDays(today, 1 - DIGEST_DAYS)]);
  if (rows.length === 0) return null;
  const text = rows[0].text;
  if (typeof text !== "string") throw new DbError("unknown");
  return text.trim() === "" ? null : text;
}

export async function readDeskFacts(q: Queryable, now: Date, zone: string): Promise<DeskFacts> {
  const header = await readFeedHeader(q, now.getTime());
  const rows = await q.query<{ n: unknown }>(DONE_SQL, [todayStartIso(now, zone)]);
  if (rows.length !== 1) throw new DbError("unknown");
  return { checkedAt: header.deskCheckedAt, doneToday: wholeNumber(rows[0].n) };
}

export async function readAutopilotFacts(q: Queryable, now: Date): Promise<AutopilotFacts> {
  const picture = await readRules(q, now.getTime());
  const saved = new Map(picture.rules.map((r) => [r.kind, r]));
  const auto = picture.kinds
    .filter((k) => k.mode === "auto" && k.armed && k.allowedAuto)
    .flatMap((k) => {
      // A limit we cannot name is left out, never shown as $0.00.
      const maxCents = saved.get(k.kind)?.maxCents ?? k.ceiling?.maxCents;
      return maxCents === undefined || maxCents === null ? [] : [{ kind: k.kind, maxCents }];
    });
  return {
    on: flags.autopilot.enabled === true && flags.autopilot.armed === true,
    paused: picture.pause.paused,
    pausedAt: picture.pause.pausedAt,
    auto,
  };
}

// The loads on this demo carrier's board, or null when it is not a demo carrier on the sample system.
export async function readBoardCount(q: Queryable): Promise<number | null> {
  if (!(await demoCarrierOf(q))) return null;
  const board = await readBoard(q);
  return board === null ? null : board.rows.length;
}

export async function readTourFacts(o: { now: Date; today: LocalDate; timezone: string }): Promise<TourFacts> {
  const [digest, desk, autopilot, board] = await Promise.all([
    flags.morningDigest.enabled
      ? loaded("tour digest", () => withRequestTenant((q) => readDigestLine(q, o.today)))
      : ({ ok: true, value: null } as const),
    loaded("tour desk", () => withRequestTenant((q) => readDeskFacts(q, o.now, o.timezone))),
    flags.autopilotRules.enabled ? loaded("tour autopilot", () => withRequestTenant((q) => readAutopilotFacts(q, o.now))) : null,
    flags.mockTms.enabled ? loaded("tour board", () => withRequestTenant((q) => readBoardCount(q))) : null,
  ]);
  return { digest, desk, autopilot, board };
}
