import { describe, expect, it } from "vitest";
import { NOTE_REF_TABLE } from "@/lib/memory/links";
import { traceLines, traceTotals } from "./format";
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
