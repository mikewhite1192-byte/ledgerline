import { describe, expect, it } from "vitest";
import { isLocalDate } from "../time/local-date";
import { DEMO_ANCHOR } from "./anchor";
import manifest from "./docs/manifest.json";

describe("DEMO_ANCHOR", () => {
  it("is a whole date and the anchor the sample documents were rendered for", () => {
    expect(isLocalDate(DEMO_ANCHOR)).toBe(true);
    expect(manifest.anchor).toBe(DEMO_ANCHOR);
  });
});
