import { afterEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import { settingsRows } from "./rows";

// The Settings list leaves out Demo for a judge or a visit's own copy, who cannot reset the demo.
const saved = { demo: flags.demoResetEnabled, simple: flags.simpleShape };

afterEach(() => {
  flags.demoResetEnabled = saved.demo;
  flags.simpleShape = saved.simple;
});

describe("settingsRows", () => {
  it("keeps Demo for an admin and leaves it out when asked to hide it", () => {
    flags.demoResetEnabled = true;
    flags.simpleShape = { enabled: true };
    expect(settingsRows(false).rows.map((r) => r.href)).toContain("/settings/demo");
    expect(settingsRows().rows.map((r) => r.href)).toContain("/settings/demo");
    const hidden = settingsRows(true).rows.map((r) => r.href);
    expect(hidden).not.toContain("/settings/demo");
    expect(hidden.length).toBe(settingsRows(false).rows.length - 1);
  });
});
