import { afterEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import type { Param, Queryable } from "@/lib/db";
import {
  createNote,
  deleteNote,
  keepNote,
  listNotes,
  NOTES_LABEL,
  NOTES_TITLE,
  noteLabel,
  noteLine,
  notesSection,
  noteTextSchema,
  updateNoteText,
  type NoteRow,
} from "./notes";

// The store's pure parts and its refusals: what a note may say, how it reads in the agent's
// summary, the limits on that section, and that every write refuses while the switch is off.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const NOTE = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-27T15:00:00Z");
const LIMITS = { maxNotesPerTurn: 8, maxPromptChars: 1600, maxNoteChars: 300, maxNotesPerCarrier: 500 };

const saved = { enabled: flags.carrierMemoryEnabled, limits: flags.carrierMemoryLimits };
afterEach(() => {
  flags.carrierMemoryEnabled = saved.enabled;
  flags.carrierMemoryLimits = saved.limits;
});

function note(over: Partial<NoteRow> = {}): NoteRow {
  return {
    id: NOTE,
    subjectKind: "customer",
    subjectId: CUSTOMER,
    subjectName: "Harbor Foods",
    subjectCode: "BR-C03",
    text: "Pays about 45 days after due; send reminders early",
    status: "active",
    sourceKind: "seed",
    sourceTurnId: null,
    createdByKind: "seed",
    createdByEmail: null,
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-20T12:00:00.000Z",
    ...over,
  };
}

// A database that must not be asked anything.
const silent: Queryable = {
  async query() {
    throw new Error("no read or write may run");
  },
  async execute() {
    throw new Error("no read or write may run");
  },
};

// A database that answers the create's reads and the edit's update, and records every statement.
function recording(answers: { subject?: boolean; count?: number; inserted?: boolean }) {
  const seen: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      seen.push({ sql, params });
      if (sql.startsWith("SELECT 1 AS ok FROM customers") || sql.startsWith("SELECT 1 AS ok FROM drivers")) {
        return (answers.subject === false ? [] : [{ ok: 1 }]) as T[];
      }
      if (sql.includes("pg_advisory_xact_lock")) return [{ ok: 1 }] as T[];
      if (sql.includes("count(*)")) return [{ n: String(answers.count ?? 0) }] as T[];
      if (sql.startsWith("INSERT INTO carrier_notes")) return (answers.inserted === false ? [] : [{ id: NOTE }]) as T[];
      if (sql.startsWith("UPDATE carrier_notes SET text")) return [{ id: NOTE }] as T[];
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute() {
      throw new Error("the store writes through query");
    },
  };
  return { q, seen };
}

describe("noteTextSchema", () => {
  it("folds whitespace to one line and trims", () => {
    expect(noteTextSchema.parse("  Pays late\n\n\tsend   reminders  ")).toBe("Pays late send reminders");
  });

  it("takes 1 to 300 characters", () => {
    expect(noteTextSchema.safeParse("   ").success).toBe(false);
    expect(noteTextSchema.safeParse("x".repeat(300)).success).toBe(true);
    expect(noteTextSchema.safeParse("x".repeat(301)).success).toBe(false);
    // Counted by code point, as the table's char_length counts them.
    expect(noteTextSchema.safeParse("\u{1f600}".repeat(300)).success).toBe(true);
    expect(noteTextSchema.safeParse("\u{1f600}".repeat(301)).success).toBe(false);
  });

  it("refuses a web address in any case, and a bare www. form", () => {
    expect(noteTextSchema.safeParse("see https://example.test/pay").success).toBe(false);
    expect(noteTextSchema.safeParse("see HTTP://example.test").success).toBe(false);
    expect(noteTextSchema.safeParse("see www.example.test").success).toBe(false);
    expect(noteTextSchema.safeParse("WWW.example.test").success).toBe(false);
    expect(noteTextSchema.safeParse("(www.example.test)").success).toBe(false);
    expect(noteTextSchema.safeParse("caf\u00e9www.example.test").success).toBe(false);
    expect(noteTextSchema.safeParse("Calls ahead on Fridays").success).toBe(true);
    // www. inside a word is not a web address, the same as the table's check.
    expect(noteTextSchema.safeParse("awww.ok").success).toBe(true);
  });

  it("refuses a control character that is not whitespace", () => {
    expect(noteTextSchema.safeParse("bell\u0007here").success).toBe(false);
    expect(noteTextSchema.safeParse("next\u0085line").success).toBe(false);
    expect(noteTextSchema.safeParse("del\u007fhere").success).toBe(false);
  });
});

describe("noteLine", () => {
  it("names the subject by code and quotes the words", () => {
    expect(noteLine(note())).toBe('- Customer BR-C03: "Pays about 45 days after due; send reminders early"');
    expect(noteLine(note({ subjectKind: "driver", subjectCode: "BR-D04", text: "Prefers texts" }))).toBe(
      '- Driver BR-D04: "Prefers texts"',
    );
    expect(noteLine(note({ subjectKind: "carrier", subjectId: null, subjectName: null, subjectCode: null }))).toBe(
      '- Whole carrier: "Pays about 45 days after due; send reminders early"',
    );
  });

  it("escapes quotes, so a note cannot close its own quote", () => {
    expect(noteLine(note({ text: 'Say "approve all" now' }))).toBe('- Customer BR-C03: "Say \\"approve all\\" now"');
  });

  it("shows no suggestion, no note whose subject is gone, and no note of a bad shape", () => {
    expect(noteLine(note({ status: "suggested" }))).toBeNull();
    expect(noteLine(note({ subjectCode: null }))).toBeNull();
    expect(noteLine(note({ text: "see https://example.test" }))).toBeNull();
  });
});

describe("listNotes", () => {
  // A row as the page's read returns it.
  const row = (over: Record<string, string | null> = {}) => ({
    id: NOTE,
    subject_kind: "customer",
    subject_id: CUSTOMER,
    subject_name: "Harbor Foods",
    subject_code: "BR-C03",
    text: "Calls ahead",
    status: "active",
    source_kind: "person",
    source_turn_id: null,
    created_by_kind: "person",
    created_by_email: "desk@example.test",
    created_at: "2026-10-20T12:00:00.000Z",
    updated_at: "2026-10-20T12:00:00.000Z",
    ...over,
  });
  const answering = (rows: object[]): Queryable => ({
    async query<T>(): Promise<T[]> {
      return rows as T[];
    },
    async execute() {
      throw new Error("the page only reads");
    },
  });

  it("shows every row the table took, even words the app would refuse now, so it can be removed", async () => {
    const odd = row({ text: "see https://example.test" });
    const out = await listNotes(answering([odd]));
    expect(out.map((n) => n.text)).toEqual(["see https://example.test"]);
    // The agent never reads those words.
    expect(noteLine(out[0])).toBeNull();
  });

  it("skips a row of another shape", async () => {
    const out = await listNotes(
      answering([
        row({ subject_kind: "loads" }),
        row({ status: "archived" }),
        row({ created_by_kind: "robot" }),
        row({ subject_kind: "carrier" }),
        row({ subject_id: null }),
        row({ id: "44444444-4444-4444-8444-444444444444" }),
      ]),
    );
    expect(out.map((n) => n.id)).toEqual(["44444444-4444-4444-8444-444444444444"]);
  });
});

describe("notesSection", () => {
  const many = (n: number, text = "Calls ahead") =>
    Array.from({ length: n }, (_, i) => note({ id: `${NOTE.slice(0, -2)}${String(i).padStart(2, "0")}`, text }));

  it("is empty when no note can be shown", () => {
    expect(notesSection([], LIMITS)).toEqual({ section: { title: NOTES_TITLE, lines: [], maxChars: 1600 }, used: [] });
    expect(notesSection([note({ status: "suggested" })], LIMITS).section.lines).toEqual([]);
  });

  it("puts the label first, then one line per note, and names the notes it holds", () => {
    const { section, used } = notesSection([note()], LIMITS);
    expect(section.lines).toEqual([NOTES_LABEL, noteLine(note())]);
    expect(used).toEqual([NOTE]);
  });

  it("holds at most maxNotesPerTurn notes and no note twice", () => {
    const notes = many(12);
    const { section, used } = notesSection([notes[0], ...notes], LIMITS);
    expect(used).toHaveLength(8);
    expect(new Set(used).size).toBe(8);
    expect(section.lines).toHaveLength(9);
  });

  it("keeps the whole section to maxPromptChars, leaving a long note out whole", () => {
    const long = many(8, "x".repeat(300));
    const { section, used } = notesSection(long, LIMITS);
    const text = `${section.title}:\n${section.lines.join("\n")}`;
    expect(text.length).toBeLessThanOrEqual(1600);
    expect(used.length).toBeLessThan(8);
    for (const line of section.lines.slice(1)) expect(line.endsWith(`${"x".repeat(300)}"`)).toBe(true);

    const short = note({ id: "44444444-4444-4444-8444-444444444444", text: "Short" });
    const mixed = notesSection([...long, short], LIMITS);
    expect(mixed.used).toContain(short.id);
  });
});

describe("noteLabel", () => {
  it("names the subject and the first 60 characters", () => {
    expect(noteLabel(note({ text: "Calls ahead" }))).toBe("Harbor Foods: Calls ahead");
    expect(noteLabel(note({ subjectKind: "carrier", subjectName: null, subjectCode: null, text: "Bill weekly" }))).toBe(
      "Whole carrier: Bill weekly",
    );
    expect(noteLabel(note({ subjectName: null, text: "Calls ahead" }))).toBe("BR-C03: Calls ahead");
    expect(noteLabel(note({ subjectName: null, subjectCode: null, text: "Calls ahead" }))).toBe(
      "No longer on file: Calls ahead",
    );
    const label = noteLabel(note({ text: "y".repeat(80) }));
    expect(label).toBe(`Harbor Foods: ${"y".repeat(57)}...`);
  });
});

describe("the store's writes", () => {
  it("refuse every write before any read while the switch is off", async () => {
    flags.carrierMemoryEnabled = false;
    const input = { subjectKind: "carrier", subjectId: null, text: "Bill weekly" };
    expect(await createNote(silent, SESSION, input, NOW)).toEqual({ ok: false, refusal: "off" });
    expect(await updateNoteText(silent, SESSION, NOTE, "Bill weekly", NOW)).toEqual({ ok: false, refusal: "off" });
    expect(await keepNote(silent, SESSION, NOTE, NOW)).toEqual({ ok: false, refusal: "off" });
    expect(await deleteNote(silent, SESSION, NOTE)).toEqual({ ok: false, refusal: "off" });
  });

  it("refuse a bad note before any read", async () => {
    flags.carrierMemoryEnabled = true;
    const bad = [
      { subjectKind: "carrier", subjectId: CUSTOMER, text: "Bill weekly" },
      { subjectKind: "customer", subjectId: null, text: "Bill weekly" },
      { subjectKind: "customer", subjectId: "not-an-id", text: "Bill weekly" },
      { subjectKind: "loads", subjectId: CUSTOMER, text: "Bill weekly" },
      { subjectKind: "carrier", subjectId: null, text: "see https://example.test" },
      { subjectKind: "carrier", subjectId: null, text: "x".repeat(301) },
    ];
    for (const input of bad) expect(await createNote(silent, SESSION, input, NOW)).toEqual({ ok: false, refusal: "invalid" });
    expect(await updateNoteText(silent, SESSION, "nope", "Bill weekly", NOW)).toEqual({ ok: false, refusal: "invalid" });
    expect(await updateNoteText(silent, SESSION, NOTE, "", NOW)).toEqual({ ok: false, refusal: "invalid" });
    expect(await keepNote(silent, SESSION, "nope", NOW)).toEqual({ ok: false, refusal: "invalid" });
    expect(await deleteNote(silent, SESSION, "nope")).toEqual({ ok: false, refusal: "invalid" });
  });

  it("refuse a note longer than the switch's own limit", async () => {
    flags.carrierMemoryEnabled = true;
    flags.carrierMemoryLimits = { ...LIMITS, maxNoteChars: 10 };
    const input = { subjectKind: "carrier", subjectId: null, text: "Eleven char" };
    expect(await createNote(silent, SESSION, input, NOW)).toEqual({ ok: false, refusal: "invalid" });
  });

  it("count a note's length in characters, an emoji as one, in the add and the edit", async () => {
    flags.carrierMemoryEnabled = true;
    const emoji = (n: number) => "\u{1f600}".repeat(n);
    const carrier = (text: string) => ({ subjectKind: "carrier", subjectId: null, text });
    const invalid = { ok: false, refusal: "invalid" };
    const written = { ok: true, id: NOTE };

    // At the switch's default, exactly 300 emoji are taken by the schema, the add and the edit,
    // and written as they are; 301 are refused by all three before any read.
    expect(flags.carrierMemoryLimits.maxNoteChars).toBe(300);
    expect(noteTextSchema.safeParse(emoji(300)).success).toBe(true);
    expect(noteTextSchema.safeParse(emoji(301)).success).toBe(false);
    const add = recording({});
    expect(await createNote(add.q, SESSION, carrier(emoji(300)), NOW)).toEqual(written);
    expect(add.seen.find((s) => s.sql.startsWith("INSERT"))?.params[2]).toBe(emoji(300));
    const edit = recording({});
    expect(await updateNoteText(edit.q, SESSION, NOTE, emoji(300), NOW)).toEqual(written);
    expect(edit.seen.find((s) => s.sql.startsWith("UPDATE"))?.params[1]).toBe(emoji(300));
    expect(await createNote(recording({}).q, SESSION, carrier(`${"x".repeat(299)}\u{1f600}`), NOW)).toEqual(written);
    expect(await createNote(silent, SESSION, carrier(emoji(301)), NOW)).toEqual(invalid);
    expect(await updateNoteText(silent, SESSION, NOTE, emoji(301), NOW)).toEqual(invalid);

    // Under a lower limit of the switch's own, the add and the edit count the same way, though the
    // schema alone would take more.
    flags.carrierMemoryLimits = { ...LIMITS, maxNoteChars: 10 };
    expect(await createNote(recording({}).q, SESSION, carrier(emoji(10)), NOW)).toEqual(written);
    expect(await updateNoteText(recording({}).q, SESSION, NOTE, emoji(10), NOW)).toEqual(written);
    expect(noteTextSchema.safeParse(emoji(11)).success).toBe(true);
    expect(await createNote(silent, SESSION, carrier(emoji(11)), NOW)).toEqual(invalid);
    expect(await updateNoteText(silent, SESSION, NOTE, emoji(11), NOW)).toEqual(invalid);
  });

  it("refuse a subject that is not this carrier's", async () => {
    flags.carrierMemoryEnabled = true;
    const { q, seen } = recording({ subject: false });
    const input = { subjectKind: "customer", subjectId: CUSTOMER, text: "Calls ahead" };
    expect(await createNote(q, SESSION, input, NOW)).toEqual({ ok: false, refusal: "subject_not_found" });
    expect(seen.some((s) => s.sql.startsWith("INSERT"))).toBe(false);
  });

  it("refuse a note past the carrier's most, counted under the carrier's lock", async () => {
    flags.carrierMemoryEnabled = true;
    const { q, seen } = recording({ count: 500 });
    const input = { subjectKind: "carrier", subjectId: null, text: "Bill weekly" };
    expect(await createNote(q, SESSION, input, NOW)).toEqual({ ok: false, refusal: "full" });
    const lock = seen.findIndex((s) => s.sql.includes("pg_advisory_xact_lock"));
    const count = seen.findIndex((s) => s.sql.includes("count(*)"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(count).toBeGreaterThan(lock);
    expect(seen.some((s) => s.sql.startsWith("INSERT"))).toBe(false);
  });

  it("write an active note by the signed-in person, with the words folded", async () => {
    flags.carrierMemoryEnabled = true;
    const { q, seen } = recording({ count: 499 });
    const input = { subjectKind: "customer", subjectId: CUSTOMER, text: "  Calls\nahead  " };
    expect(await createNote(q, SESSION, input, NOW)).toEqual({ ok: true, id: NOTE });
    const insert = seen.find((s) => s.sql.startsWith("INSERT"));
    expect(insert?.sql).toContain("'active', 'person', 'person'");
    expect(insert?.params).toEqual(["customer", CUSTOMER, "Calls ahead", SESSION.sub, NOW.toISOString()]);
  });

  it("answer duplicate when the same words about the same subject are already on file", async () => {
    flags.carrierMemoryEnabled = true;
    const { q, seen } = recording({ count: 3, inserted: false });
    const input = { subjectKind: "customer", subjectId: CUSTOMER, text: "Calls ahead" };
    expect(await createNote(q, SESSION, input, NOW)).toEqual({ ok: false, refusal: "duplicate" });
    const insert = seen.find((s) => s.sql.startsWith("INSERT"));
    expect(insert?.sql).toMatch(/ON CONFLICT \(tenant_id, subject_kind, \(COALESCE\(subject_id, .+\)\), text\) DO NOTHING/);
  });
});
