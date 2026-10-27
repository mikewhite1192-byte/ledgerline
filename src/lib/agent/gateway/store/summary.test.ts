import { describe, expect, it } from "vitest";
import { STATE_HEADER } from "../../policy";
import { assembleSummary } from "./summary";

describe("assembleSummary", () => {
  it("keeps the sections in order under the header and skips empty ones", () => {
    const text = assembleSummary(
      [
        { title: "Carrier", lines: ["Blue Ridge"], maxChars: 200 },
        { title: "Empty", lines: [], maxChars: 200 },
        { title: "Proposals", lines: ["advance BR-D07 $200.00 proposed"], maxChars: 200 },
      ],
      10_000,
    );
    expect(text).toBe(`${STATE_HEADER}\n\nCarrier:\nBlue Ridge\n\nProposals:\nadvance BR-D07 $200.00 proposed`);
  });

  it("cuts a section to its own cap", () => {
    const text = assembleSummary([{ title: "Long", lines: ["x".repeat(500)], maxChars: 50 }], 10_000);
    const section = text.split("\n\n")[1];
    expect(section).toHaveLength(50);
    expect(section.endsWith("...")).toBe(true);
  });

  it("cuts the whole from the bottom to the turn's cap, never over 10,000 characters", () => {
    const sections = Array.from({ length: 30 }, (_, i) => ({ title: `S${i}`, lines: ["y".repeat(900)], maxChars: 1_000 }));
    const text = assembleSummary(sections, 10_000);
    expect(text).toHaveLength(10_000);
    expect(text.startsWith(STATE_HEADER)).toBe(true);
    expect(text).toContain("S0:");
    expect(text).not.toContain("S29:");
    expect(text.endsWith("...")).toBe(true);
  });
});
