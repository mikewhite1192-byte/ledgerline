// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

afterEach(cleanup);

const TENANT = { name: "Test Carrier", email: "office@example.test", timezone: "America/Chicago" };
const NAV = [
  { group: "Today", href: "/", label: "Home", icon: null },
  { group: "Pay", href: "/advances", label: "Advances", icon: null },
];

function shell(current: string | null) {
  return render(
    <AppShell tenant={TENANT} nav={NAV.map((i) => ({ ...i, current: i.href === current }))} title="Page" signOut={null}>
      <p>Body</p>
    </AppShell>,
  );
}

describe("AppShell top bar", () => {
  it("names the current page's menu group", () => {
    const { container } = shell("/advances");
    expect(container.querySelector("header > p")?.textContent).toBe("Pay");
  });

  it("prints no group line on a page with no menu item", () => {
    const { container } = shell(null);
    expect(container.querySelector("header > p")).toBeNull();
    expect(screen.getByText("Body")).toBeTruthy();
  });
});
