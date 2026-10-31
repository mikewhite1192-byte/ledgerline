import { describe, expect, it } from "vitest";
import { cardAnchor, isCardAnchor } from "./card-anchor";

const ID = "22222222-2222-4222-8222-222222222222";

describe("the card anchor", () => {
  it("names a card by its proposal id", () => {
    expect(cardAnchor(ID)).toBe(`card-${ID}`);
  });

  it("takes only a whole #card-<id> hash, never a stray or longer one", () => {
    expect(isCardAnchor(`#${cardAnchor(ID)}`)).toBe(true);
    expect(isCardAnchor(cardAnchor(ID))).toBe(false);
    expect(isCardAnchor("#card-nope")).toBe(false);
    expect(isCardAnchor(`#card-${ID}x`)).toBe(false);
    expect(isCardAnchor(`#x-card-${ID}`)).toBe(false);
    expect(isCardAnchor("#ask")).toBe(false);
    expect(isCardAnchor("")).toBe(false);
  });
});
