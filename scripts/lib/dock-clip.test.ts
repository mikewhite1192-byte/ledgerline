import { describe, expect, it } from "vitest";
import { carrierBySlug } from "../../src/lib/seed/carriers";
import { CLIP_FRAMES, cameraClock, cropFor, dockPlant, frameSpecs, STILL_PROMPTS } from "./dock-clip";

// The demo clip's plan, without ffmpeg or a model: the seeded stop it shows and the clock it
// burns in. Making the clip itself is a development step (npm run clips:demo), never a test.

const carrier = carrierBySlug("blue-ridge")!;

describe("the demo dock clip plan", () => {
  it("shows the seeded BR-L10216 delivery in the carrier's zone", () => {
    expect(dockPlant(carrier, "2026-11-02", "BR-L10216", "delivery")).toEqual({
      loadNumber: "BR-L10216",
      stop: "delivery",
      customerName: "Acme Beverage Group",
      zone: "America/New_York",
      arrivedAt: "2026-10-21T21:46:00.000Z",
      departedAt: "2026-10-22T23:46:00.000Z",
    });
    expect(() => dockPlant(carrier, "2026-11-02", "NO-SUCH-LOAD", "delivery")).toThrow();
  });

  it("runs the clock from the arrival for the first half and from the departure for the second", () => {
    const frames = frameSpecs(dockPlant(carrier, "2026-11-02", "BR-L10216", "delivery"));
    expect(frames).toHaveLength(CLIP_FRAMES);
    expect(frames[0]).toMatchObject({ scene: "dock", zoom: 1, clock: "10/21/2026 05:46:00 PM" });
    expect(frames[71].clock).toBe("10/21/2026 05:46:08 PM");
    expect(frames[72].clock).toBe("10/22/2026 07:46:00 PM");
    expect(frames.map((f) => f.scene).filter((s, i, all) => s !== all[i - 1])).toEqual(["dock", "trailer", "dock", "form"]);
    expect(cameraClock(Date.parse("2026-10-22T16:00:09Z"), "America/New_York")).toBe("10/22/2026 12:00:09 PM");
  });

  it("asks the image model for pictures with no text, and crops to the clip size", () => {
    for (const prompt of Object.values(STILL_PROMPTS)) expect(prompt.toLowerCase()).toMatch(/no (text|words|writing)/);
    expect(cropFor(1.1, 704, 396)).toEqual({ left: 32, top: 18, width: 640, height: 360 });
  });
});
