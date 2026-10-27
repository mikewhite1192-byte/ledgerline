import { afterEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import { appNav } from "./app-nav";

const saved = { driverNotesEnabled: flags.driverNotesEnabled, sweepEnabled: flags.sweepEnabled };
afterEach(() => {
  flags.driverNotesEnabled = saved.driverNotesEnabled;
  flags.sweepEnabled = saved.sweepEnabled;
});

const shape = (current: string) => appNav(current).map((i) => [i.href, i.label, i.current ?? false]);

describe("appNav", () => {
  it("lists driver notes only while their switch is on, and marks the current page", () => {
    flags.driverNotesEnabled = false;
    flags.sweepEnabled = false;
    expect(shape("/models")).toEqual([
      ["/", "Home", false],
      ["/models", "Meta models", true],
    ]);
    flags.driverNotesEnabled = true;
    expect(shape("/driver-notes")).toEqual([
      ["/", "Home", false],
      ["/driver-notes", "Driver notes", true],
      ["/models", "Meta models", false],
    ]);
  });

  it("lists the sweep only while its switch is on", () => {
    flags.driverNotesEnabled = false;
    flags.sweepEnabled = false;
    expect(shape("/").map(([href]) => href)).not.toContain("/sweep");
    flags.sweepEnabled = true;
    expect(shape("/sweep")).toEqual([
      ["/", "Home", false],
      ["/sweep", "Sweep", true],
      ["/models", "Meta models", false],
    ]);
  });
});
