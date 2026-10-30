import { z } from "zod";
import type { Queryable } from "../../db";
import { assertRefsExist } from "./refs";
import type { RefTable } from "./types";

// The record a page is about, carried by a question asked from that page (design-ui-pass 2). The
// client sends only a table from this closed list and a uuid. The server checks both with the
// gateway's own ref check (an allowed table, a row of the caller's tenant), then reads the label
// itself from the database: the client never supplies any text that reaches the model. The
// result becomes the state summary's Subject line; the person's message is untouched.
//
// Only tables the ref check already allows: factoring requests and sweep runs are not on its
// list, so a page about one sends no focus.
export const FOCUS_TABLES = [
  "settlements",
  "drivers",
  "invoices",
  "loads",
  "advances",
  "settlement_periods",
  "customers",
] as const satisfies readonly RefTable[];

export type FocusTable = (typeof FOCUS_TABLES)[number];

export const pageFocusSchema = z.strictObject({ table: z.enum(FOCUS_TABLES), id: z.uuid() });

export type PageFocus = z.infer<typeof pageFocusSchema>;

// What the Subject line says: the table and id, short words read from the record, and at most one
// amount, which the line states through the summary's money() so the figure is sayable.
export type FocusSubject = {
  table: FocusTable;
  id: string;
  words: string[];
  amount: { what: "net" | "amount"; cents: number } | null;
};

type Row = Record<string, unknown>;

// One statement per table. Each names the tenant and joins only rows of the same tenant, as the
// ref check does, so a login that bypasses row-level security still reads one tenant only.
const LABEL_SQL: Record<FocusTable, string> = {
  drivers:
    "SELECT d.first_name, d.last_name, d.code FROM drivers d" +
    " WHERE d.tenant_id = current_tenant_id() AND d.id = CAST($1 AS uuid)",
  customers:
    "SELECT c.name, c.code FROM customers c" +
    " WHERE c.tenant_id = current_tenant_id() AND c.id = CAST($1 AS uuid)",
  invoices:
    "SELECT i.invoice_number, i.status, to_char(i.due_on, 'YYYY-MM-DD') AS due_on, i.amount_cents," +
    " c.code AS customer_code FROM invoices i" +
    " JOIN customers c ON c.tenant_id = i.tenant_id AND c.id = i.customer_id" +
    " WHERE i.tenant_id = current_tenant_id() AND i.id = CAST($1 AS uuid)",
  loads:
    "SELECT l.load_number, l.status, to_char(l.pickup_on, 'YYYY-MM-DD') AS pickup_on," +
    " c.code AS customer_code, d.code AS driver_code FROM loads l" +
    " JOIN customers c ON c.tenant_id = l.tenant_id AND c.id = l.customer_id" +
    " LEFT JOIN drivers d ON d.tenant_id = l.tenant_id AND d.id = l.driver_id" +
    " WHERE l.tenant_id = current_tenant_id() AND l.id = CAST($1 AS uuid)",
  advances:
    "SELECT d.first_name, d.last_name, d.code, a.status, to_char(a.requested_on, 'YYYY-MM-DD') AS requested_on," +
    " a.amount_cents FROM advances a" +
    " JOIN drivers d ON d.tenant_id = a.tenant_id AND d.id = a.driver_id" +
    " WHERE a.tenant_id = current_tenant_id() AND a.id = CAST($1 AS uuid)",
  settlement_periods:
    "SELECT to_char(p.period_start, 'YYYY-MM-DD') AS period_start," +
    " to_char(p.period_end, 'YYYY-MM-DD') AS period_end, p.status FROM settlement_periods p" +
    " WHERE p.tenant_id = current_tenant_id() AND p.id = CAST($1 AS uuid)",
  settlements:
    "SELECT d.first_name, d.last_name, d.code, to_char(p.period_end, 'YYYY-MM-DD') AS period_end," +
    " s.status, s.net_cents FROM settlements s" +
    " JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id" +
    " JOIN settlement_periods p ON p.tenant_id = s.tenant_id AND p.id = s.period_id" +
    " WHERE s.tenant_id = current_tenant_id() AND s.id = CAST($1 AS uuid)",
};

const WORD_MAX = 60;

// A stored value as a short plain word: letters, digits, spaces and . _ ' & - only, whitespace
// collapsed, cut to 60 characters. Anything else (a line break, a quote, a colon) becomes a space,
// so a record's text can never start a new line or section of the summary.
export function safeWord(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const clean = raw
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N} ._'&-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, WORD_MAX).trim();
}

const CODE_PATTERN = /^[\p{L}\p{N}._-]{1,32}$/u;

// A stored code or number (a driver or customer code, an invoice or load number) as one token:
// after NFC and a trim, letters, digits and . _ - only, 1 to 32 characters, no space. Anything
// else gives "", so the code is left out rather than cleaned: a load number can come from an
// approved proposal's argument, and a code with sentence text in it is no code. Names stay on
// safeWord.
export function safeCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const clean = raw.normalize("NFC").trim();
  return CODE_PATTERN.test(clean) ? clean : "";
}

// "Name (CODE)", either part alone when the other cleans to nothing. The name goes through
// safeWord, the code through safeCode.
function named(rawName: unknown, rawCode: unknown): string {
  const name = safeWord(rawName);
  const code = safeCode(rawCode);
  return name && code ? `${name} (${code})` : name || code;
}

function person(row: Row): string {
  return named(`${safeWord(row.first_name)} ${safeWord(row.last_name)}`, row.code);
}

// "prefix word", or nothing when the word is empty. The word is already clean.
function prefixed(prefix: string, word: string): string[] {
  return word ? [`${prefix} ${word}`] : [];
}

function cents(raw: unknown): number | null {
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// "label value", or nothing when the stored value cleans to nothing.
function labelled(label: string, raw: unknown): string[] {
  return prefixed(label, safeWord(raw));
}

// "label CODE", or nothing when the stored code is not one plain token (safeCode).
function coded(label: string, raw: unknown): string[] {
  return prefixed(label, safeCode(raw));
}

function subjectOf(table: FocusTable, id: string, row: Row): FocusSubject {
  const amount = (what: "net" | "amount", raw: unknown) => {
    const n = cents(raw);
    return n === null ? null : { what, cents: n };
  };
  switch (table) {
    case "drivers":
      return { table, id, words: prefixed("driver", person(row)), amount: null };
    case "customers":
      return { table, id, words: prefixed("customer", named(row.name, row.code)), amount: null };
    case "invoices":
      return {
        table,
        id,
        words: [
          ...coded("invoice", row.invoice_number),
          ...coded("customer", row.customer_code),
          ...labelled("status", row.status),
          ...labelled("due", row.due_on),
        ],
        amount: amount("amount", row.amount_cents),
      };
    case "loads":
      return {
        table,
        id,
        words: [
          ...coded("load", row.load_number),
          ...coded("customer", row.customer_code),
          ...coded("driver", row.driver_code),
          ...labelled("status", row.status),
          ...labelled("pickup", row.pickup_on),
        ],
        amount: null,
      };
    case "advances":
      return {
        table,
        id,
        words: [
          ...prefixed("advance for", person(row)),
          ...labelled("status", row.status),
          ...labelled("requested", row.requested_on),
        ],
        amount: amount("amount", row.amount_cents),
      };
    case "settlement_periods": {
      const start = safeWord(row.period_start);
      const end = safeWord(row.period_end);
      return {
        table,
        id,
        words: [...(start && end ? [`pay week ${start} to ${end}`] : []), ...labelled("status", row.status)],
        amount: null,
      };
    }
    case "settlements":
      return {
        table,
        id,
        words: [
          ...prefixed("settlement for", person(row)),
          ...labelled("week ending", row.period_end),
          ...labelled("status", row.status),
        ],
        amount: amount("net", row.net_cents),
      };
  }
}

// Inside the turn's tenant transaction, before any row is written. Null on any miss: a shape the
// schema refuses, a table off the ref check's list, an id that is not a row of this tenant, or a
// label read that does not find exactly one row. A failed read throws, and the turn opens nothing.
export async function readFocus(q: Queryable, focus: unknown): Promise<FocusSubject | null> {
  const parsed = pageFocusSchema.safeParse(focus);
  if (!parsed.success) return null;
  const { table, id } = parsed.data;
  if (!(await assertRefsExist(q, [{ table, id }]))) return null;
  const rows = await q.query<Row>(LABEL_SQL[table], [id]);
  if (rows.length !== 1) return null;
  return subjectOf(table, id.toLowerCase(), rows[0]);
}

// Pure: the Subject line, "<table> <id>, <words>, <net or amount> $X". The amount goes through
// money(), so the summary records its cents and the answer may say it.
export function focusLine(s: FocusSubject, money: (cents: number) => string): string {
  const parts = [`${s.table} ${s.id}`, ...s.words];
  if (s.amount) parts.push(`${s.amount.what} ${money(s.amount.cents)}`);
  return parts.join(", ");
}
