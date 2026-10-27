import { afterEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import { appNav, type NavKey } from "./app-nav";

const saved = {
  driverNotes: flags.driverNotesEnabled,
  sweep: flags.sweepEnabled,
  portalRunner: flags.portalRunnerEnabled,
  documents: flags.documentsEnabled,
  advances: flags.advancesEnabled,
  invoices: flags.invoicesEnabled,
  customerPayments: flags.customerPaymentsEnabled,
  voiceIntake: flags.voiceIntakeEnabled,
  clips: flags.clipsEnabled,
  cashFriday: flags.cashFridayEnabled,
};
afterEach(() => {
  flags.driverNotesEnabled = saved.driverNotes;
  flags.sweepEnabled = saved.sweep;
  flags.portalRunnerEnabled = saved.portalRunner;
  flags.documentsEnabled = saved.documents;
  flags.advancesEnabled = saved.advances;
  flags.invoicesEnabled = saved.invoices;
  flags.customerPaymentsEnabled = saved.customerPayments;
  flags.voiceIntakeEnabled = saved.voiceIntake;
  flags.clipsEnabled = saved.clips;
  flags.cashFridayEnabled = saved.cashFriday;
});

const shape = (current: NavKey) => appNav(current).map((i) => [i.href, i.label, i.current ?? false]);

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

  it("lists every item, in order, when every switch is on", () => {
    flags.sweepEnabled = true;
    flags.documentsEnabled = true;
    flags.advancesEnabled = true;
    flags.driverNotesEnabled = true;
    flags.invoicesEnabled = true;
    flags.customerPaymentsEnabled = true;
    flags.voiceIntakeEnabled = true;
    flags.clipsEnabled = true;
    flags.portalRunnerEnabled = true;
    flags.cashFridayEnabled = true;
    expect(shape("/invoices")).toEqual([
      ["/", "Home", false],
      ["/sweep", "Sweep", false],
      ["/documents", "Documents", false],
      ["/advances", "Advances", false],
      ["/driver-notes", "Driver notes", false],
      ["/invoices", "Invoices", true],
      ["/customer-payments/new", "Payments", false],
      ["/cash", "Cash", false],
      ["/voice-notes", "Voice notes", false],
      ["/clips", "Dock clips", false],
      ["/models", "Meta models", false],
      ["/portal-runs", "Portal runs", false],
    ]);
  });

  it("lists Cash only while Cash Friday is switched on", () => {
    flags.cashFridayEnabled = false;
    expect(shape("/").map(([href]) => href)).not.toContain("/cash");
    flags.cashFridayEnabled = true;
    expect(appNav("/cash").find((i) => i.current)).toMatchObject({ href: "/cash", label: "Cash" });
  });
});
