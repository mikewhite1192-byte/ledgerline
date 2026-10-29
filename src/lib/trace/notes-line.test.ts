import { describe, expect, it } from "vitest";
import { NOTE_REF_TABLE } from "@/lib/memory/links";
import { auditorNotesKey, isNotesLine, traceLines, traceTotals } from "./format";
import { SAMPLE_PROPOSAL_ID, sampleTrace } from "./sample";

// The trace names the carrier notes a turn's summary held (CARRIER-MEMORY): one line first, on the
// whole turn's view only, each note linking to its row on the Memory page, a removed one counted.

const A = "77777777-7777-4777-8777-000000000001";
const B = "77777777-7777-4777-8777-000000000002";
const GONE = "77777777-7777-4777-8777-000000000003";

describe("the notes line", () => {
  it("is absent when the turn held no notes, so older traces read as before", () => {
    const before = traceLines(sampleTrace());
    expect(traceLines({ ...sampleTrace(), notesUsed: [] })).toEqual(before);
    expect(before.some((l) => l.key === "memory")).toBe(false);
  });

  it("comes first and names each note it can, linking to Memory", () => {
    const trace = {
      ...sampleTrace(),
      notesUsed: [
        { id: A, label: "Whole carrier: Bill detention the same week" },
        { id: B, label: "Harbor Foods: Pays about 45 days after due" },
      ],
    };
    const [first, ...rest] = traceLines(trace);
    expect(first).toEqual({
      key: "memory",
      who: "Memory",
      meta: [],
      text: "Remembered 2 notes from the office",
      badge: null,
      refs: [
        { table: NOTE_REF_TABLE, id: A, label: "Whole carrier: Bill detention the same week" },
        { table: NOTE_REF_TABLE, id: B, label: "Harbor Foods: Pays about 45 days after due" },
      ],
    });
    expect(rest).toEqual(traceLines(sampleTrace()));
  });

  it("counts a note removed since, without naming it", () => {
    const trace = { ...sampleTrace(), notesUsed: [{ id: A, label: "Whole carrier: Bill weekly" }, { id: GONE, label: null }] };
    const [first] = traceLines(trace);
    expect(first.text).toBe("Remembered 2 notes from the office; 1 has since been removed");
    expect(first.refs.map((r) => r.id)).toEqual([A]);
    const allGone = traceLines({ ...sampleTrace(), notesUsed: [{ id: GONE, label: null }, { id: B, label: null }] })[0];
    expect(allGone.text).toBe("Remembered 2 notes from the office; 2 have since been removed");
    expect(allGone.refs).toEqual([]);
  });

  it("stays off a card's view and out of the cost footer", () => {
    const trace = { ...sampleTrace(), notesUsed: [{ id: A, label: "Whole carrier: Bill weekly" }] };
    expect(traceLines(trace, SAMPLE_PROPOSAL_ID).some((l) => l.key === "memory")).toBe(false);
    expect(traceTotals(trace)).toBe(traceTotals(sampleTrace()));
  });
});

// A card's second check names the notes it saw (CARRIER-MEMORY PR 2): one line after the check's
// own, on that card's view, each note linking to Memory, a removed one counted.
describe("the second check's notes line", () => {
  const withAuditorNotes = (auditorNotes: { id: string; label: string | null }[]) => {
    const t = sampleTrace();
    return { ...t, proposals: t.proposals.map((p) => (p.id === SAMPLE_PROPOSAL_ID ? { ...p, auditorNotes } : p)) };
  };

  it("is absent when the check saw no notes, so older cards read as before", () => {
    const before = traceLines(sampleTrace(), SAMPLE_PROPOSAL_ID);
    expect(traceLines(withAuditorNotes([]), SAMPLE_PROPOSAL_ID)).toEqual(before);
    expect(before.some((l) => l.key === auditorNotesKey(SAMPLE_PROPOSAL_ID))).toBe(false);
  });

  it("follows the check's own line on the card and links each note it can name", () => {
    const trace = withAuditorNotes([
      { id: A, label: "Driver T-104: Prefers a text before a call" },
      { id: GONE, label: null },
    ]);
    const lines = traceLines(trace, SAMPLE_PROPOSAL_ID);
    const at = lines.findIndex((l) => l.key === auditorNotesKey(SAMPLE_PROPOSAL_ID));
    expect(lines[at - 1].key).toBe(`proposal:${SAMPLE_PROPOSAL_ID}:auditor`);
    expect(lines[at]).toEqual({
      key: `proposal:${SAMPLE_PROPOSAL_ID}:notes`,
      who: "Memory",
      meta: [],
      text: "Notes the second check saw: 2 notes from the office; 1 has since been removed",
      badge: null,
      refs: [{ table: NOTE_REF_TABLE, id: A, label: "Driver T-104: Prefers a text before a call" }],
    });
    expect(isNotesLine(lines[at])).toBe(true);
    // Everything else on the card is as before, and the line adds no model call to the footer.
    expect(lines.filter((_, i) => i !== at)).toEqual(traceLines(sampleTrace(), SAMPLE_PROPOSAL_ID));
    expect(traceTotals(trace, SAMPLE_PROPOSAL_ID)).toBe(traceTotals(sampleTrace(), SAMPLE_PROPOSAL_ID));
  });

  it("stays off the whole turn's view", () => {
    const trace = withAuditorNotes([{ id: B, label: "Whole carrier: Bill weekly" }]);
    expect(traceLines(trace)).toEqual(traceLines(sampleTrace()));
  });

  it("tells a notes line from a records line by its key alone", () => {
    const line = (key: string) => ({ key, who: "x", meta: [], text: "x", badge: null, refs: [] });
    expect(isNotesLine(line("memory"))).toBe(true);
    expect(isNotesLine(line(auditorNotesKey(SAMPLE_PROPOSAL_ID)))).toBe(true);
    for (const key of [`proposal:${SAMPLE_PROPOSAL_ID}:auditor`, "proposal::notes", "proposal:a:b:notes", "step:1", "memory:x"]) {
      expect(isNotesLine(line(key)), key).toBe(false);
    }
  });
});
