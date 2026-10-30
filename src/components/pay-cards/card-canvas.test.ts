import { describe, expect, it } from "vitest";
import { fitPng } from "./card-canvas";
import type { DrawArt } from "./draw";

// A picture that takes the card past the check's size cap is dropped, never the words: the card is
// drawn once more on the plain background. A card that fits is drawn once.

const ART: DrawArt = { image: {} as CanvasImageSource, width: 864, height: 1080 };
const blob = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: "image/png" });

function drawer(withArt: number, plain: number) {
  const calls: DrawArt[] = [];
  const draw = async (art: DrawArt) => {
    calls.push(art);
    return blob(art ? withArt : plain);
  };
  return { draw, calls };
}

describe("fitPng", () => {
  it("keeps the picture when the card fits", async () => {
    const { draw, calls } = drawer(300, 100);
    expect((await fitPng(draw, ART, 400)).size).toBe(300);
    expect(calls).toEqual([ART]);
  });

  it("keeps the picture at exactly the cap", async () => {
    const { draw, calls } = drawer(400, 100);
    expect((await fitPng(draw, ART, 400)).size).toBe(400);
    expect(calls).toEqual([ART]);
  });

  it("draws the plain card when the picture takes it past the cap", async () => {
    const { draw, calls } = drawer(401, 100);
    expect((await fitPng(draw, ART, 400)).size).toBe(100);
    expect(calls).toEqual([ART, null]);
  });

  it("draws once with no picture, even past the cap (the server refuses it)", async () => {
    const { draw, calls } = drawer(0, 500);
    expect((await fitPng(draw, null, 400)).size).toBe(500);
    expect(calls).toEqual([null]);
  });
});
