// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initials, TenantPanel, TenantSwitcher, type TenantInfo } from "./tenant-switcher";

afterEach(cleanup);

const tenant: TenantInfo = { name: "Sample Freight Co", email: "ops@samplefreight.example", timezone: "America/Chicago" };
const signOut = <button type="button">Sign out</button>;

describe("TenantPanel", () => {
  it("lists exactly one carrier, marked current, with the sign-out control", () => {
    const { container } = render(<TenantPanel tenant={tenant} signOut={signOut} />);
    expect(screen.getAllByText(tenant.name)).toHaveLength(1);
    const current = screen.getByText("(current)");
    expect(current.className).toContain("sr-only");
    expect(current.previousElementSibling?.textContent).toBe(tenant.name);
    const check = current.nextElementSibling as Element;
    expect(check.tagName.toLowerCase()).toBe("svg");
    expect(check.getAttribute("aria-hidden")).toBe("true");
    expect(check.hasAttribute("aria-label")).toBe(false);
    expect(screen.getByText("This login belongs to one carrier")).toBeTruthy();
    expect(container.textContent).toContain(tenant.email);
    expect(container.textContent).toContain("Time zone: America/Chicago");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Appearance" })).toBeTruthy();
  });
});

describe("TenantSwitcher", () => {
  it("opens from the chip and closes on Escape", () => {
    const { container } = render(<TenantSwitcher tenant={tenant} signOut={signOut} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    const summary = details.querySelector("summary") as HTMLElement;
    expect(within(summary).getByText(/carrier menu/)).toBeTruthy();

    details.open = true;
    fireEvent.keyDown(document, { key: "Escape" });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("closes when the pointer goes down outside it", () => {
    const { container } = render(<TenantSwitcher tenant={tenant} signOut={signOut} />);
    const details = container.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent.pointerDown(document.body);
    expect(details.open).toBe(false);
  });
});

describe("initials", () => {
  it("takes the first letters of the first two words", () => {
    expect(initials("Sample Freight Co")).toBe("SF");
    expect(initials("Acme")).toBe("AC");
    expect(initials("  ")).toBe("?");
  });
});
