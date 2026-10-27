import type { Session } from "../../../auth/claims";
import { readPayConfigFor, readTenant } from "../../../data/read";
import { payConfigOf } from "../../../data/records";
import type { Queryable } from "../../../db";
import { dollars } from "../../../money/format";
import { localDateOf, periodContaining } from "../../../time/local-date";
import { STATE_HEADER } from "../../policy";

// The compact state summary (design 2.3, tip 5): Muse Spark never sees the chat history, only
// this one system message rebuilt from the database on every turn. Sections in a fixed order,
// each with its own cap, then the whole cut from the bottom to the turn's cap. Untrusted text
// never enters it: no message bodies, subjects or senders, only ids, codes, enums and cents.

export type SummarySection = { title: string; lines: string[]; maxChars: number };

const ELLIPSIS = "...";

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= ELLIPSIS.length ? text.slice(0, max) : text.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}

// Pure: sections in order, each cut to its own cap, the whole cut from the bottom to cap.
export function assembleSummary(sections: readonly SummarySection[], cap: number): string {
  const parts = [STATE_HEADER];
  for (const s of sections) {
    if (s.lines.length === 0) continue;
    parts.push(cut([`${s.title}:`, ...s.lines].join("\n"), s.maxChars));
  }
  return cut(parts.join("\n\n"), cap);
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type PriorRow = { seq: number; summary: string };
type ProposalRow = {
  id: string;
  kind: string;
  subject_label: string | null;
  amount_cents: number | string;
  status: string;
  flagged: boolean;
  auditor_verdict: string | null;
};
type BlockRow = { tool: string; reason: string; limit_cents: number | string | null };
type SubjectRow = { subject_table: string | null; subject_id: string | null };

const LABEL_SQL = `CASE p.subject_table
    WHEN 'drivers' THEN (SELECT d.code FROM drivers d WHERE d.id = p.subject_id)
    WHEN 'invoices' THEN (SELECT i.invoice_number FROM invoices i WHERE i.id = p.subject_id)
  END`;

// Inside a tenant transaction (the store opens it). Returns the text, its size, and every cents
// figure it states.
export async function buildStateSummary(
  q: Queryable,
  _session: Session,
  conversationId: string,
  now: Date,
  cap: number,
): Promise<{ text: string; chars: number; cents: number[] }> {
  const cents: number[] = [];
  const money = (n: number) => {
    cents.push(n);
    return dollars(n);
  };
  const sections: SummarySection[] = [];

  const tenant = await readTenant(q);
  const zone = tenant?.timezone ?? "UTC";
  const today = localDateOf(now.toISOString(), zone);
  const header: string[] = [];
  if (tenant) header.push(`Carrier: ${tenant.name}`);
  header.push(`Time zone: ${zone}`, `Today: ${today}`);

  const rules: string[] = [];
  try {
    const config = payConfigOf(await readPayConfigFor(q, today));
    const dow = config.weekStartDow;
    const week = periodContaining(today, dow);
    header.push(`Pay week: ${DOW[dow]} to ${DOW[(dow + 6) % 7]}, this week ${week.start} to ${week.end}`);
    rules.push(`Advance fee: ${money(config.advanceFeeCents)}`);
    rules.push(`Default advance limit per driver: ${money(config.advanceLimitDefaultCents)}`);
    rules.push(`Advances up to ${config.advanceMaxBpsOfEarned / 100}% of earned, unpaid pay`);
    rules.push(`Smallest advance: ${money(config.advanceMinCents)}`);
    rules.push(`Percentage pay base: ${config.percentBase}`);
    rules.push(`Net pay floor per settlement: ${money(config.netPayFloorCents)}`);
  } catch {
    rules.push("Pay rules: not available");
  }
  sections.push({ title: "Carrier", lines: header, maxChars: 300 });
  sections.push({ title: "Pay rules", lines: rules, maxChars: 600 });

  const subject = await q.query<SubjectRow>(
    "SELECT subject_table, subject_id FROM conversations WHERE id = CAST($1 AS uuid)",
    [conversationId],
  );
  const s = subject[0];
  if (s && s.subject_table && s.subject_id) {
    sections.push({
      title: "Subject",
      lines: [`${s.subject_table} ${s.subject_id}`],
      maxChars: 800,
    });
  }

  const prior = await q.query<PriorRow>(
    `SELECT seq, summary FROM turns
      WHERE conversation_id = CAST($1 AS uuid) AND status <> 'running' AND summary <> ''
      ORDER BY seq DESC LIMIT 5`,
    [conversationId],
  );
  sections.push({
    title: "Earlier in this conversation",
    lines: prior.reverse().map((t) => `- ${cut(t.summary, 120)}`),
    maxChars: 5 * 124 + 40,
  });

  const proposals = await q.query<ProposalRow>(
    `SELECT p.id, p.kind, ${LABEL_SQL} AS subject_label, p.amount_cents, p.status,
            (p.flagged_input_id IS NOT NULL) AS flagged, p.auditor_verdict
       FROM proposals p
      WHERE p.conversation_id = CAST($1 AS uuid)
      ORDER BY p.created_at DESC, p.id LIMIT 10`,
    [conversationId],
  );
  sections.push({
    title: "Proposals in this conversation",
    lines: proposals.map(
      (p) =>
        `- ${p.id} ${p.kind} ${p.subject_label ?? "record"} ${money(Number(p.amount_cents))} ` +
        `${p.status}, flagged ${p.flagged ? "yes" : "no"}, auditor ${p.auditor_verdict ?? "none"}`,
    ),
    maxChars: 1600,
  });

  const blocks = await q.query<BlockRow>(
    `SELECT g.tool, g.reason, g.limit_cents
       FROM gateway_decisions g
       JOIN turns t ON t.id = g.turn_id
      WHERE t.conversation_id = CAST($1 AS uuid) AND g.decision <> 'allowed'
      ORDER BY g.created_at DESC, g.id LIMIT 5`,
    [conversationId],
  );
  sections.push({
    title: "Refused tool calls in this conversation",
    lines: blocks.map(
      (b) =>
        `- ${b.tool}: ${b.reason}` +
        (b.limit_cents === null ? "" : `, limit ${money(Number(b.limit_cents))}`),
    ),
    maxChars: 600,
  });

  const text = assembleSummary(sections, cap);
  return { text, chars: text.length, cents };
}
