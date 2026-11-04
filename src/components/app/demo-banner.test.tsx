// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { flags } from "@/config/flags";
import { VISIT_EMAIL } from "@/lib/visit-copy/visitor";
import { AppShell } from "./app-shell";
import { DemoBanner } from "./demo-banner";

afterEach(cleanup);

const NAV = [{ group: "Today", href: "/", label: "Home", icon: null, current: true }];
const tenant = (role: "admin" | "staff" | "judge") => ({
  name: "Blue Ridge Freight Lines",
  email: "visitor@example.test",
  timezone: "America/New_York",
  role,
});

describe("DemoBanner", () => {
  it("names the carrier, never the visit's model budget, with Start over and Leave", () => {
    render(<DemoBanner carrier="Blue Ridge Freight Lines" />);
    const region = screen.getByRole("region", { name: "Demo visit" });
    expect(region.textContent).toContain("You are visiting Blue Ridge Freight Lines, a demo carrier with made-up data.");
    expect(region.textContent).not.toMatch(/model time|\$/);
    const over = screen.getByRole("button", { name: "Start over" }).closest("form");
    expect(over?.getAttribute("action")).toBe("/");
    expect(over?.getAttribute("method")).toBe("get");
    expect(over?.querySelector("input[name=new]")?.getAttribute("value")).toBe("1");
    const leave = screen.getByRole("button", { name: "Leave" }).closest("form");
    expect(leave?.getAttribute("action")).toBe("/api/auth/sign-out");
    expect(leave?.getAttribute("method")).toBe("post");
  });

  it("shows in the shell for a demo visitor only", () => {
    for (const role of ["admin", "staff", "judge"] as const) {
      render(
        <AppShell tenant={tenant(role)} nav={NAV} title="Page" signOut={null}>
          <p>Body</p>
        </AppShell>,
      );
      expect(screen.queryByRole("region", { name: "Demo visit" }) !== null, role).toBe(role === "judge");
      cleanup();
    }
  });

  it("tells a visit's own copy it is its own, in plain words with no amounts, and hides Demo settings", () => {
    const saved = flags.visitCopies.enabled;
    const savedSimple = flags.simpleShape;
    // The full shell's banner; the simple shape's one notice has its own short line.
    flags.simpleShape = { enabled: false };
    const nav = [
      ...NAV,
      { group: "Settings", href: "/settings/demo", label: "Demo", icon: null, current: false },
    ];
    const visitor = { ...tenant("admin"), email: VISIT_EMAIL };
    try {
      flags.visitCopies.enabled = true;
      render(
        <AppShell tenant={visitor} nav={nav} title="Page" signOut={null}>
          <p>Body</p>
        </AppShell>,
      );
      const region = screen.getByRole("region", { name: "Demo visit" });
      expect(region.textContent).toContain(
        "This is your own copy of Blue Ridge Freight Lines, a demo carrier with made-up data. Nothing real is paid or sent, and your copy is removed after your visit.",
      );
      expect(region.textContent).not.toMatch(/\$|cent/i);
      expect(screen.queryByRole("link", { name: "Demo" })).toBeNull();
      expect(document.body.textContent).not.toContain(VISIT_EMAIL);
      cleanup();

      // An admin of the carrier itself sees no banner and keeps Demo settings.
      render(
        <AppShell tenant={tenant("admin")} nav={nav} title="Page" signOut={null}>
          <p>Body</p>
        </AppShell>,
      );
      expect(screen.queryByRole("region", { name: "Demo visit" })).toBeNull();
      expect(screen.queryAllByRole("link", { name: "Demo" }).length).toBeGreaterThan(0);
      cleanup();

      // A judge in the shared carrier cannot reset it either, so Demo settings are hidden.
      render(
        <AppShell tenant={tenant("judge")} nav={nav} title="Page" signOut={null}>
          <p>Body</p>
        </AppShell>,
      );
      expect(screen.queryByRole("link", { name: "Demo" })).toBeNull();
      cleanup();

      // With the switch off nothing changes for anyone.
      flags.visitCopies.enabled = false;
      render(
        <AppShell tenant={visitor} nav={nav} title="Page" signOut={null}>
          <p>Body</p>
        </AppShell>,
      );
      expect(screen.queryByRole("region", { name: "Demo visit" })).toBeNull();
    } finally {
      flags.simpleShape = savedSimple;
      flags.visitCopies.enabled = saved;
    }
  });
});
