import type { Queryable } from "../db";
import { readNoteSource, type StoredNoteSource } from "./pack";
import type { NoteLanguage } from "./verify";
import { fallbackLine } from "./words";

// What the notes pages read. Every read runs inside the page's tenant transaction and names the
// tenant.

export type NotePeriod = {
  id: string;
  periodStart: string;
  periodEnd: string;
  settled: number;
  drafted: number;
  approved: number;
  waiting: number;
};

// Pay periods with settled pay, newest first, with their note counts.
export async function listNotePeriods(q: Queryable, limit = 12): Promise<NotePeriod[]> {
  const rows = await q.query<Record<string, string | number>>(
    `SELECT CAST(p.id AS text) AS id,
            to_char(p.period_start, 'YYYY-MM-DD') AS period_start,
            to_char(p.period_end, 'YYYY-MM-DD') AS period_end,
            count(s.id) AS settled,
            count(n.id) FILTER (WHERE n.status IN ('drafted', 'approved', 'rejected')) AS drafted,
            count(n.id) FILTER (WHERE n.status = 'approved') AS approved,
            count(n.id) FILTER (WHERE n.status = 'drafted') AS waiting
       FROM settlement_periods p
       JOIN settlements s ON s.tenant_id = p.tenant_id AND s.period_id = p.id
                         AND s.status IN ('approved', 'paid')
       LEFT JOIN driver_notes n ON n.tenant_id = s.tenant_id AND n.settlement_id = s.id
      WHERE p.tenant_id = current_tenant_id() AND s.tenant_id = current_tenant_id()
      GROUP BY p.id, p.period_start, p.period_end
      ORDER BY p.period_start DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    periodStart: String(r.period_start),
    periodEnd: String(r.period_end),
    settled: Number(r.settled),
    drafted: Number(r.drafted),
    approved: Number(r.approved),
    waiting: Number(r.waiting),
  }));
}

export type NoteRecord = {
  id: string;
  status: string;
  language: NoteLanguage;
  body: string | null;
  citedSeqs: number[];
  refusalCategory: string | null;
  decidedAt: string | null;
};

export type NoteCard = {
  settlementId: string;
  driverName: string;
  driverCode: string;
  language: NoteLanguage;
  netCents: number;
  note: NoteRecord | null;
  citedLines: { seq: number; label: string }[];
  fallback: string;
};

export type PeriodNotes = {
  period: { id: string; periodStart: string; periodEnd: string };
  cards: NoteCard[];
};

type NoteRow = {
  settlement_id: string;
  first_name: string;
  last_name: string;
  code: string;
  preferred_language: string;
  net_cents: number | string;
  note_id: string | null;
  status: string | null;
  language: string | null;
  body: string | null;
  cited_seqs: string | null;
  refusal_category: string | null;
  decided_at: string | null;
};

function asLanguage(value: string | null): NoteLanguage {
  return value === "es" ? "es" : "en";
}

function parseSeqs(text: string | null): number[] {
  if (!text) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) return [];
  return value.filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n));
}

// One period's settled settlements with their notes (or none yet), ordered by driver code.
export async function readPeriodNotes(q: Queryable, periodId: string): Promise<PeriodNotes | null> {
  const periods = await q.query<{ id: string; period_start: string; period_end: string }>(
    `SELECT CAST(id AS text) AS id, to_char(period_start, 'YYYY-MM-DD') AS period_start,
            to_char(period_end, 'YYYY-MM-DD') AS period_end
       FROM settlement_periods WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [periodId],
  );
  if (periods.length !== 1) return null;
  const p = periods[0];
  const rows = await q.query<NoteRow>(
    `SELECT CAST(s.id AS text) AS settlement_id, d.first_name, d.last_name, d.code, d.preferred_language,
            s.net_cents, CAST(n.id AS text) AS note_id, n.status, n.language, n.body,
            CAST(n.cited_seqs AS text) AS cited_seqs, n.refusal_category,
            to_char(n.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
       FROM settlements s
       JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
       LEFT JOIN driver_notes n ON n.tenant_id = s.tenant_id AND n.settlement_id = s.id
      WHERE s.tenant_id = current_tenant_id() AND d.tenant_id = current_tenant_id()
        AND s.period_id = CAST($1 AS uuid) AND s.status IN ('approved', 'paid')
      ORDER BY d.code`,
    [periodId],
  );
  // Labels of the lines the notes cite, in one read.
  const labels = await q.query<{ settlement_id: string; seq: number; label: string }>(
    `SELECT CAST(l.settlement_id AS text) AS settlement_id, l.seq, l.label
       FROM settlement_lines l
       JOIN driver_notes n ON n.tenant_id = l.tenant_id AND n.settlement_id = l.settlement_id
      WHERE l.tenant_id = current_tenant_id() AND n.tenant_id = current_tenant_id()
        AND n.period_id = CAST($1 AS uuid)
        AND n.cited_seqs @> to_jsonb(l.seq)`,
    [periodId],
  );
  const labelOf = new Map(labels.map((l) => [`${l.settlement_id}:${l.seq}`, l.label]));
  const cards = rows.map((r): NoteCard => {
    const language = asLanguage(r.note_id ? r.language : r.preferred_language);
    const netCents = Number(r.net_cents);
    const note: NoteRecord | null = r.note_id
      ? {
          id: r.note_id,
          status: r.status ?? "drafting",
          language,
          body: r.body,
          citedSeqs: parseSeqs(r.cited_seqs),
          refusalCategory: r.refusal_category,
          decidedAt: r.decided_at,
        }
      : null;
    return {
      settlementId: r.settlement_id,
      driverName: `${r.first_name} ${r.last_name}`,
      driverCode: r.code,
      language,
      netCents,
      note,
      citedLines: (note?.citedSeqs ?? []).map((seq) => ({
        seq,
        label: labelOf.get(`${r.settlement_id}:${seq}`) ?? `Line ${seq}`,
      })),
      fallback: fallbackLine(language, p.period_start, p.period_end, netCents),
    };
  });
  return { period: { id: p.id, periodStart: p.period_start, periodEnd: p.period_end }, cards };
}

export type DriverView = {
  source: StoredNoteSource;
  // What the driver sees above the paystub: the approved note, the fallback line, or nothing yet.
  message: { kind: "note"; body: string; language: NoteLanguage } | { kind: "fallback"; body: string } | null;
};

// The driver's view of one settlement: the paystub, and the note only once a person approved it.
// A note that failed the check or was rejected shows the code-built fallback line instead.
export async function readDriverView(q: Queryable, settlementId: string): Promise<DriverView | null> {
  const source = await readNoteSource(q, settlementId);
  if (!source) return null;
  const notes = await q.query<{ status: string; body: string | null; language: string }>(
    `SELECT status, body, language FROM driver_notes
      WHERE tenant_id = current_tenant_id() AND settlement_id = CAST($1 AS uuid)`,
    [settlementId],
  );
  const note = notes[0];
  const language = asLanguage(note ? note.language : source.driver.preferred_language);
  let message: DriverView["message"] = null;
  if (note?.status === "approved" && note.body) {
    message = { kind: "note", body: note.body, language };
  } else if (note && (note.status === "refused" || note.status === "rejected")) {
    message = {
      kind: "fallback",
      body: fallbackLine(language, source.period.period_start, source.period.period_end, source.settlement.net_cents),
    };
  }
  return { source, message };
}
