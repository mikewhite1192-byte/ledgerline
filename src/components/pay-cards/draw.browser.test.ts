import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPayCardPng, PAY_CARD_HEIGHT, PAY_CARD_WIDTH, pngSize } from "@/lib/pay-cards/png";
import { cardSpec } from "@/lib/pay-cards/spec";
import { drawPayCard } from "./draw";

// The same drawing function, run from its own source text in a real browser page, makes a PNG
// the check route accepts: 1080 by 1350 and under the size cap. No server, no network, no files.
// Skips where no browser is installed (the CI unit job installs none).

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
  driver: { id: "c1f0a9d2-3b4e-4f60-8a71-92b3c4d5e6f7", first_name: "Ana", preferred_language: "es" },
  lines: [
    { kind: "load_pay", amount_cents: 141_200, sources: [{ table: "loads", id: "L-1" }], meta: { loadedMiles: 1_000, emptyMiles: 50 } },
    { kind: "lease", amount_cents: -95_000, sources: [], meta: null },
  ],
  previousNetCents: 50_000,
  previousLines: [{ kind: "load_pay", amount_cents: 130_000 }],
});

let browser: Browser | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch();
  } catch {
    browser = null;
  }
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

describe("drawPayCard in a browser", () => {
  it("makes a PNG of the card's size, on the plain background, under the cap", async (ctx) => {
    if (!browser) ctx.skip();
    if (!spec) throw new Error("no spec");
    const page = await browser!.newPage();
    try {
      await page.setContent("<!doctype html><html><body></body></html>");
      // A build step may wrap nested functions in a naming helper; the page gets a no-op one.
      await page.addScriptTag({ content: `window.__name = (f) => f; window.drawPayCard = ${drawPayCard.toString()};` });
      const base64 = await page.evaluate(
        async ({ text, width, height }) => {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const c = canvas.getContext("2d");
          if (!c) throw new Error("no drawing surface");
          (window as unknown as { drawPayCard: (...a: unknown[]) => void }).drawPayCard(c, text, null, "sans-serif");
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("no picture");
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let s = "";
          for (const b of bytes) s += String.fromCharCode(b);
          return btoa(s);
        },
        { text: spec.text, width: PAY_CARD_WIDTH, height: PAY_CARD_HEIGHT },
      );
      const png = new Uint8Array(Buffer.from(base64, "base64"));
      expect(pngSize(png)).toEqual({ width: PAY_CARD_WIDTH, height: PAY_CARD_HEIGHT });
      expect(isPayCardPng(png, 400_000)).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
});
