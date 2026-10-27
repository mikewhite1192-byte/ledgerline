import { describe, expect, it } from "vitest";
import { prepareImage } from "./prepare";

describe("prepareImage", () => {
  it("returns its input unchanged until cropping is built", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const out = await prepareImage(bytes, "image/jpeg");
    expect(out.bytes).toBe(bytes);
    expect(out.mime).toBe("image/jpeg");
    expect(out.cropped).toBe(false);
  });
});
