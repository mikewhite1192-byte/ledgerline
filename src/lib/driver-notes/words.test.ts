import { describe, expect, it } from "vitest";
import { fallbackLine, periodWords, refusalWords } from "./words";

describe("periodWords", () => {
  it("writes the period in each language", () => {
    expect(periodWords("en", "2026-10-26", "2026-11-01")).toBe("Oct 26 to Nov 1, 2026");
    expect(periodWords("es", "2026-10-26", "2026-11-01")).toBe("del 26 de octubre al 1 de noviembre de 2026");
    expect(periodWords("es", "2026-12-28", "2027-01-03")).toBe("del 28 de diciembre de 2026 al 3 de enero de 2027");
  });

  it("refuses a date in another shape or a period that ends first", () => {
    expect(() => periodWords("es", "2026-13-01", "2026-13-07")).toThrow(RangeError);
    expect(() => periodWords("es", "2026-11-01", "2026-10-26")).toThrow(RangeError);
  });
});

describe("fallbackLine", () => {
  it("builds the short pay line from the net pay alone", () => {
    expect(fallbackLine("en", "2026-10-26", "2026-11-01", 110000)).toBe(
      "Your pay for Oct 26 to Nov 1, 2026 is $1,100.00. Your paystub lists every line.",
    );
    expect(fallbackLine("es", "2026-10-26", "2026-11-01", 110000)).toBe(
      "Su pago del 26 de octubre al 1 de noviembre de 2026 es $1,100.00. Su recibo de pago muestra cada línea.",
    );
  });
});

describe("refusalWords", () => {
  it("says why in fixed words, with a default for an unknown reason", () => {
    expect(refusalWords("number_mismatch")).toBe(
      "Not shown to the driver: the draft had a number that is not on the paystub.",
    );
    expect(refusalWords("something_new")).toBe("Not shown to the driver: the model call failed.");
    expect(refusalWords(null)).toBe("Not shown to the driver: the model call failed.");
  });
});
