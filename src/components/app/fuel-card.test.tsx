// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FuelCardChip } from "./fuel-card";

afterEach(cleanup);

describe("FuelCardChip", () => {
  it("shows the last four and a Test mode badge, with a generic icon hidden from readers", () => {
    const { container } = render(<FuelCardChip last4="4417" />);
    expect(container.textContent).toBe("Fuel card ending 4417Test mode");
    expect(screen.getByText("Test mode")).toBeTruthy();
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("img")).toBeNull();
  });

  it("names no card network, vendor or brand, only plain words", () => {
    for (const props of [{}, { status: "closed" as const }, { testMode: false }]) {
      const { container, unmount } = render(<FuelCardChip last4="4417" {...props} />);
      expect(container.textContent).not.toMatch(/visa|mastercard|amex|american express|discover|wex|efs|comdata|atob|fleetcor|stripe/i);
      expect(container.textContent).toMatch(/^Fuel card ending 4417(, closed)?(Test mode)?$/);
      unmount();
    }
  });

  it("says a closed card is closed", () => {
    const { container } = render(<FuelCardChip last4="4417" status="closed" />);
    expect(container.textContent).toContain("Fuel card ending 4417, closed");
  });

  it("leaves the badge off when told the card is not in test mode", () => {
    const { container } = render(<FuelCardChip last4="4417" testMode={false} />);
    expect(container.textContent).toBe("Fuel card ending 4417");
  });

  it("wraps on a narrow screen instead of overflowing", () => {
    const { container } = render(<FuelCardChip last4="4417" />);
    expect((container.firstChild as HTMLElement).className).toContain("flex-wrap");
  });
});
