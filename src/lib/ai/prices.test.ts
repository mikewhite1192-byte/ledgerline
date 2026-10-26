import { describe, expect, it } from "vitest";
import {
  actualCost,
  capNanocents,
  centsToDisplay,
  CREDIT_CENTS,
  dollarsToDisplay,
  estimateReserve,
  NANOCENTS_PER_CENT,
  priceFor,
} from "./prices";

describe("prices", () => {
  it("lists Meta's Standard prices in nanocents per token, exactly", () => {
    // $1.25, $0.15 and $4.25 per million tokens.
    for (const model of ["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1"]) {
      expect(priceFor("meta", model), model).toEqual({
        input: 125_000,
        cached: 15_000,
        output: 425_000,
      });
    }
    expect(priceFor("baseten", "meta-models/muse-spark-open-1026")).toEqual({
      input: 125_000,
      cached: 15_000,
      output: 425_000,
    });
    // A million output tokens is 425 cents.
    expect(1_000_000 * priceFor("meta", "muse-spark-1.3")!.output).toBe(425 * NANOCENTS_PER_CENT);
  });

  it("refuses models it has no price for, the contributor tier and prototype keys included", () => {
    for (const model of [
      "muse-spark-1.3-contributor",
      "muse-spark-1.2-contributor",
      "muse-image-1.0",
      "muse-spark",
      "",
      "constructor",
      "__proto__",
    ]) {
      expect(priceFor("meta", model), model).toBeNull();
    }
    expect(priceFor("baseten", "muse-spark-1.3")).toBeNull();
    expect(priceFor("meta", "meta-models/muse-spark-open-1026")).toBeNull();
  });

  it("reserves a token per three request bytes of input plus every output token", () => {
    const price = priceFor("meta", "muse-spark-1.3")!;
    // 400 bytes is 134 tokens (rounded up); 256 output tokens.
    expect(estimateReserve(price, 400, 256)).toBe(134 * 125_000 + 256 * 425_000);
    expect(estimateReserve(price, 400, 256)).toBe(125_550_000);
    // The proof call's budget: 1024 output tokens is under half a cent.
    expect(estimateReserve(price, 300, 1024)).toBe(100 * 125_000 + 1024 * 425_000);
    expect(estimateReserve(price, 300, 1024)).toBeLessThan(NANOCENTS_PER_CENT / 2);
  });

  it("charges uncached input, cached input and output (reasoning is inside output)", () => {
    const price = priceFor("meta", "muse-spark-1.3")!;
    // in=134 cached=0 out=212: 16,750,000 + 90,100,000 nanocents, shown rounded up.
    const example = actualCost(price, { input: 134, cached: 0, output: 212, reasoning: 150 });
    expect(example).toBe(134 * 125_000 + 212 * 425_000);
    expect(centsToDisplay(example)).toBe("0.1069");
    // The measured call: 15 in, 64 out of which 62 reasoning. Reasoning adds nothing extra.
    const measured = actualCost(price, { input: 15, cached: 0, output: 64, reasoning: 62 });
    expect(measured).toBe(15 * 125_000 + 64 * 425_000);
    expect(measured).toBe(29_075_000);
    // Cached tokens are billed at the cached rate, not on top of input.
    expect(actualCost(price, { input: 1000, cached: 600, output: 0, reasoning: 0 })).toBe(
      400 * 125_000 + 600 * 15_000,
    );
  });

  it("reads the cap as whole cents up to the credit, and refuses anything else", () => {
    expect(capNanocents("12000")).toBe(12_000 * NANOCENTS_PER_CENT);
    expect(capNanocents("1")).toBe(NANOCENTS_PER_CENT);
    expect(capNanocents(String(CREDIT_CENTS))).toBe(15_000 * NANOCENTS_PER_CENT);
    for (const bad of [
      undefined,
      "",
      "0",
      "00",
      "-1",
      "15001",
      "120.00",
      "1e4",
      " 12000",
      "12000 ",
      "0x10",
      "abc",
    ]) {
      expect(capNanocents(bad), String(bad)).toBeNull();
    }
    // The largest cap stays a safe integer.
    expect(Number.isSafeInteger(capNanocents("15000"))).toBe(true);
  });

  it("rounds displays up, never down", () => {
    expect(centsToDisplay(0)).toBe("0.0000");
    expect(centsToDisplay(1)).toBe("0.0001");
    expect(centsToDisplay(91_700_000)).toBe("0.0917");
    expect(centsToDisplay(91_700_001)).toBe("0.0918");
    expect(centsToDisplay(2 * NANOCENTS_PER_CENT)).toBe("2.0000");
    expect(dollarsToDisplay(0)).toBe("$0.00");
    expect(dollarsToDisplay(1)).toBe("$0.01");
    expect(dollarsToDisplay(12_000 * NANOCENTS_PER_CENT)).toBe("$120.00");
    expect(dollarsToDisplay(12_345 * NANOCENTS_PER_CENT + 1)).toBe("$123.46");
  });
});
