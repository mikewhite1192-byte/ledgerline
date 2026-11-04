import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artPath, PAY_CARD_ART, PAY_CARD_ART_SHIPS } from "./art";

describe("pay card art", () => {
  it("is only requested while its files ship in public/pay-cards", () => {
    const present = PAY_CARD_ART.every((a) => existsSync(join(process.cwd(), "public", artPath(a))));
    expect(PAY_CARD_ART_SHIPS).toBe(present);
  });
});
