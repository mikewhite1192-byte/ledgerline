import { afterEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import { appNav } from "./app-nav";

const saved = flags.driverNotesEnabled;
afterEach(() => {
  flags.driverNotesEnabled = saved;
});

const shape = (current: string) => appNav(current).map((i) => [i.href, i.label, i.current ?? false]);

describe("appNav", () => {
  it("lists driver notes only while their switch is on, and marks the current page", () => {
    flags.driverNotesEnabled = false;
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
});
