import { DbError, type Queryable } from "@/lib/db";
import type { LocalDate } from "@/lib/time/local-date";
import { wholeNumber } from "./loaded";

// What came in today, for the Today card on Home: documents uploaded, voice notes recorded and
// driver messages received since midnight in the carrier's own time zone. Read inside the
// caller's carrier transaction; every count names its carrier. Nothing here writes.

export type TodayIntake = { documents: number; voiceNotes: number; messages: number };

type Row = { documents: unknown; voice_notes: unknown; messages: unknown };

// today is the carrier's date (carrierToday). The day runs from that date's midnight to the next,
// both in the carrier's zone, so a late-evening upload counts on the day the carrier saw it.
export async function readTodayIntake(q: Queryable, today: LocalDate): Promise<TodayIntake> {
  const rows = await q.query<Row>(
    `WITH day AS (
       SELECT CAST(CAST($1 AS date) AS timestamp) AT TIME ZONE t.timezone AS starts,
              CAST(CAST($1 AS date) + 1 AS timestamp) AT TIME ZONE t.timezone AS ends
         FROM tenants t WHERE t.id = current_tenant_id()
     )
     SELECT (SELECT count(*) FROM documents d
               WHERE d.tenant_id = current_tenant_id()
                 AND d.created_at >= day.starts AND d.created_at < day.ends) AS documents,
            (SELECT count(*) FROM voice_notes v
               WHERE v.tenant_id = current_tenant_id()
                 AND v.created_at >= day.starts AND v.created_at < day.ends) AS voice_notes,
            (SELECT count(*) FROM inbound_messages m
               WHERE m.tenant_id = current_tenant_id()
                 AND m.received_at >= day.starts AND m.received_at < day.ends) AS messages
       FROM day`,
    [today],
  );
  // No carrier row means the day cannot be placed: unknown, never zero.
  if (rows.length !== 1) throw new DbError("unknown");
  const [row] = rows;
  return {
    documents: wholeNumber(row.documents),
    voiceNotes: wholeNumber(row.voice_notes),
    messages: wholeNumber(row.messages),
  };
}
