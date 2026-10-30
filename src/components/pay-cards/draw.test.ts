import { describe, expect, it } from "vitest";
import { cardSpec, type CardText } from "@/lib/pay-cards/spec";
import { drawPayCard, type DrawContext } from "./draw";

// The card is drawn from the server's strings and nothing else: every piece of text on it is one
// of them, whole, so no figure is formatted, added or rounded in the browser.

type Call = { op: string; args: unknown[] };

function recorder(widthOf: (text: string, font: string) => number = (t) => t.length * 10) {
  const calls: Call[] = [];
  const ctx = {
    fillStyle: "" as DrawContext["fillStyle"],
    strokeStyle: "" as DrawContext["strokeStyle"],
    lineWidth: 1,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    save: () => calls.push({ op: "save", args: [] }),
    restore: () => calls.push({ op: "restore", args: [] }),
    fillRect: (...args: unknown[]) => calls.push({ op: "fillRect", args }),
    fillText(text: string, x: number, y: number, maxWidth?: number) {
      calls.push({ op: "fillText", args: [text, x, y, maxWidth, this.font, this.fillStyle] });
    },
    measureText(text: string) {
      return { width: widthOf(text, this.font) } as TextMetrics;
    },
    beginPath: () => calls.push({ op: "beginPath", args: [] }),
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => calls.push({ op: "fill", args: [] }),
    stroke: () => calls.push({ op: "stroke", args: [] }),
    drawImage: (...args: unknown[]) => calls.push({ op: "drawImage", args }),
  };
  return { ctx: ctx as unknown as DrawContext, calls };
}

const spec = cardSpec({
  carrierName: "Blue Ridge Freight",
  settlement: {
    id: "5b2c8f0e-1d1a-4c55-9a51-7f3e5d6a0b11",
    status: "approved",
    gross_cents: 141_200,
    deductions_cents: 95_000,
    net_cents: 46_200,
    carry_forward_cents: 5_000,
  },
  period: { period_start: "2026-10-19", period_end: "2026-10-25" },
  driver: { id: "c1f0a9d2-3b4e-4f60-8a71-92b3c4d5e6f7", first_name: "Ana", preferred_language: "en" },
  lines: [
    { kind: "load_pay", amount_cents: 141_200, sources: [{ table: "loads", id: "L-1" }], meta: { loadedMiles: 1_000, emptyMiles: 50 } },
    { kind: "lease", amount_cents: -95_000, sources: [], meta: null },
  ],
  previousNetCents: 50_000,
  previousLines: [{ kind: "load_pay", amount_cents: 130_000 }],
});

const texts = (calls: Call[]) => calls.filter((c) => c.op === "fillText").map((c) => c.args[0] as string);

describe("drawPayCard", () => {
  it("writes every line of the card's text, whole, and nothing else", () => {
    if (!spec) throw new Error("no spec");
    const { ctx, calls } = recorder();
    drawPayCard(ctx, spec.text, null, "Inter, sans-serif");
    const drawn = texts(calls);
    const expected = Object.values(spec.text).filter((v): v is string => typeof v === "string");
    expect([...drawn].sort()).toEqual([...expected].sort());
    // Every digit on the card comes from one of the server's strings.
    const allowed = new Set(expected);
    for (const t of drawn) expect(allowed.has(t)).toBe(true);
    expect(drawn).toContain("$462.00");
    expect(drawn).toContain("Carried shortfall $50.00");
    // The plain background stands in when there is no picture, and the save and restore pair up.
    expect(calls.some((c) => c.op === "fillRect")).toBe(true);
    expect(calls[0].op).toBe("save");
    expect(calls.at(-1)?.op).toBe("restore");
  });

  it("leaves out a missing biggest change and carried line", () => {
    const text: CardText = { ...(spec as NonNullable<typeof spec>).text, topChange: null, carried: null };
    const { ctx, calls } = recorder();
    drawPayCard(ctx, text, null, "sans-serif");
    expect(texts(calls)).toHaveLength(12);
  });

  it("fills the card with the picture, cropped to cover it", () => {
    const { ctx, calls } = recorder();
    const image = {} as CanvasImageSource;
    drawPayCard(ctx, (spec as NonNullable<typeof spec>).text, { image, width: 1024, height: 1024 }, "sans-serif");
    const draw = calls.find((c) => c.op === "drawImage");
    // 1024 square scaled to cover 1080 by 1350: 1350 on a side, centered.
    expect(draw?.args).toEqual([image, -135, 0, 1350, 1350]);
    expect(calls.some((c) => c.op === "fillRect")).toBe(false);
  });

  it("shrinks a long line to fit, never below 60% of its size", () => {
    const { ctx, calls } = recorder((t, font) => t.length * Number(/(\d+)px/.exec(font)?.[1] ?? 10));
    const text: CardText = { ...(spec as NonNullable<typeof spec>).text, name: "A".repeat(40) };
    drawPayCard(ctx, text, null, "sans-serif");
    const name = calls.find((c) => c.op === "fillText" && c.args[0] === text.name);
    const size = Number(/(\d+)px/.exec(String(name?.args[4]))?.[1]);
    expect(size).toBe(Math.ceil(84 * 0.6));
    // The width cap still holds the line inside the panel.
    expect(name?.args[3]).toBe(816);
  });
});
