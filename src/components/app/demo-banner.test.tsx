// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
  it("names the carrier and the visit's budget, with Start over and Leave", () => {
    render(<DemoBanner carrier="Blue Ridge Freight Lines" visitCapCents={100} />);
    const region = screen.getByRole("region", { name: "Demo visit" });
    expect(region.textContent).toContain(
      "You are visiting Blue Ridge Freight Lines, a demo carrier with made-up data. This visit can use $1.00 of model time.",
    );
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
});
