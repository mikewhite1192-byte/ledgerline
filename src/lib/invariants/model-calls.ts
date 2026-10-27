import { InvariantReadError, readAll, resultOf, tally, unreadable, whole, type InvariantResult, type ReadQuery } from "./types";
import type { Db } from "../db/types";

// I4: every model call is logged with its cost, and the spend counters agree with the log.
// - An answered call (ok or incomplete) has its cost, and a text call its input and output tokens.
// - No call has sat reserved for more than ten minutes (the database clock): a call ends answered,
//   refused or unknown, so an old reservation is a settle that never happened.
// - ops.ai_spend equals the log: spent is every settled cost, reserved is the reservations still
//   held (rows reserved, and unknown rows, whose reservation stays counted for good), calls is
//   every settled row; the auditor's counters likewise over its own rows.
// One statement, so the counters and the rows are read at the same instant.

export const STALE_RESERVED_MINUTES = 10;

export const MODEL_CALLS_SQL = `SELECT
       (SELECT count(*) FROM ops.ai_spend) AS counter_rows,
       (SELECT spent_nanocents FROM ops.ai_spend WHERE id = 1) AS counter_spent,
       (SELECT reserved_nanocents FROM ops.ai_spend WHERE id = 1) AS counter_reserved,
       (SELECT calls FROM ops.ai_spend WHERE id = 1) AS counter_calls,
       (SELECT wonder_spent_nanocents FROM ops.ai_spend WHERE id = 1) AS counter_wonder_spent,
       (SELECT wonder_reserved_nanocents FROM ops.ai_spend WHERE id = 1) AS counter_wonder_reserved,
       count(*) AS calls_logged,
       count(*) FILTER (WHERE status IN ('ok', 'incomplete') AND cost_nanocents IS NULL) AS answered_without_cost,
       count(*) FILTER (WHERE status IN ('ok', 'incomplete') AND kind = 'text'
                          AND (input_tokens IS NULL OR output_tokens IS NULL)) AS text_without_tokens,
       count(*) FILTER (WHERE status = 'reserved'
                          AND created_at < now() - interval '${STALE_RESERVED_MINUTES} minutes') AS stale_reserved,
       CAST(COALESCE(SUM(cost_nanocents), 0) AS bigint) AS spent,
       CAST(COALESCE(SUM(reserved_nanocents) FILTER (WHERE status IN ('reserved', 'unknown')), 0) AS bigint)
         AS reserved,
       count(*) FILTER (WHERE status <> 'reserved') AS settled,
       CAST(COALESCE(SUM(cost_nanocents) FILTER (WHERE target = 'wonder'), 0) AS bigint) AS wonder_spent,
       CAST(COALESCE(SUM(reserved_nanocents) FILTER (WHERE target = 'wonder' AND status IN ('reserved', 'unknown')), 0)
         AS bigint) AS wonder_reserved
  FROM model_calls`;

export type ModelCallsRow = Record<
  | "counter_rows"
  | "counter_spent"
  | "counter_reserved"
  | "counter_calls"
  | "counter_wonder_spent"
  | "counter_wonder_reserved"
  | "calls_logged"
  | "answered_without_cost"
  | "text_without_tokens"
  | "stale_reserved"
  | "spent"
  | "reserved"
  | "settled"
  | "wonder_spent"
  | "wonder_reserved",
  unknown
>;

export function judgeModelCalls(rows: ModelCallsRow[]): InvariantResult {
  if (rows.length !== 1) throw new InvariantReadError("model_calls_unread");
  const [r] = rows;
  if (whole(r.counter_rows) !== 1) throw new InvariantReadError("spend_counter_missing");
  const v: Record<string, number> = {};
  tally(v, "answered_without_cost", whole(r.answered_without_cost));
  tally(v, "text_without_tokens", whole(r.text_without_tokens));
  tally(v, "stale_reserved", whole(r.stale_reserved));
  if (whole(r.counter_spent) !== whole(r.spent)) tally(v, "counter_off:spent");
  if (whole(r.counter_reserved) !== whole(r.reserved)) tally(v, "counter_off:reserved");
  if (whole(r.counter_calls) !== whole(r.settled)) tally(v, "counter_off:calls");
  if (whole(r.counter_wonder_spent) !== whole(r.wonder_spent)) tally(v, "counter_off:wonder_spent");
  if (whole(r.counter_wonder_reserved) !== whole(r.wonder_reserved)) tally(v, "counter_off:wonder_reserved");
  return resultOf("I4", { calls: whole(r.calls_logged), settled: whole(r.settled) }, v);
}

export async function readModelCalls(q: ReadQuery): Promise<ModelCallsRow[]> {
  return q.query<ModelCallsRow>(MODEL_CALLS_SQL);
}

export async function checkModelCalls(admin: Db): Promise<InvariantResult> {
  try {
    return judgeModelCalls(await readAll(admin, readModelCalls));
  } catch (err) {
    return unreadable("I4", err);
  }
}
