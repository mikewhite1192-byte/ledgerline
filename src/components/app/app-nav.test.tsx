import { afterEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import { appNav } from "./app-nav";

const saved = {
  driverNotes: flags.driverNotesEnabled,
  sweep: flags.sweepEnabled,
  portalRunner: flags.portalRunnerEnabled,
  documents: flags.documentsEnabled,
};
afterEach(() => {
  flags.driverNotesEnabled = saved.driverNotes;
  flags.sweepEnabled = saved.sweep;
  flags.portalRunnerEnabled = saved.portalRunner;
  flags.documentsEnabled = saved.documents;
});

const shape = (current: string) => appNav(current).map((i) => [i.href, i.label, i.current ?? false]);

describe("appNav", () => {
  it("lists driver notes only while their switch is on, and marks the current page", () => {
    flags.driverNotesEnabled = false;
    flags.sweepEnabled = false;
    flags.documentsEnabled = false;
    flags.portalRunnerEnabled = false;
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
    flags.documentsEnabled = false;
    flags.portalRunnerEnabled = false;
    flags.sweepEnabled = false;
    expect(shape("/").map(([href]) => href)).not.toContain("/sweep");
    flags.sweepEnabled = true;
    expect(shape("/sweep")).toEqual([
      ["/", "Home", false],
      ["/sweep", "Sweep", true],
      ["/models", "Meta models", false],
    ]);
  });

  it("links to portal runs only while the portal runner is switched on", () => {
    flags.driverNotesEnabled = false;
    flags.sweepEnabled = false;
    flags.documentsEnabled = false;
    flags.portalRunnerEnabled = false;
    expect(appNav("/").map((i) => i.href)).toEqual(["/", "/models"]);
    flags.portalRunnerEnabled = true;
    const items = appNav("/portal-runs");
    expect(items.map((i) => i.href)).toEqual(["/", "/models", "/portal-runs"]);
    expect(items.find((i) => i.current)?.href).toBe("/portal-runs");
  });

  it("lists documents only while their switch is on", () => {
    flags.driverNotesEnabled = false;
    flags.sweepEnabled = false;
    flags.portalRunnerEnabled = false;
    flags.documentsEnabled = false;
    expect(shape("/").map(([href]) => href)).toEqual(["/", "/models"]);
    flags.documentsEnabled = true;
    expect(shape("/documents")).toEqual([
      ["/", "Home", false],
      ["/documents", "Documents", true],
      ["/models", "Meta models", false],
    ]);
  });

  it("lists the sweep above documents when both are on", () => {
    flags.driverNotesEnabled = false;
    flags.portalRunnerEnabled = false;
    flags.sweepEnabled = true;
    flags.documentsEnabled = true;
    expect(shape("/").map(([href]) => href)).toEqual(["/", "/sweep", "/documents", "/models"]);
  });
});
