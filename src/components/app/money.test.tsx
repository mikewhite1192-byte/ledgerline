// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Money } from "./money";

afterEach(cleanup);

describe("Money", () => {
  it("shows a negative with the true minus sign, the marker and the color", () => {
    render(<Money cents={-20_000} />);
    const el = screen.getByText("−$200.00");
    expect(el.hasAttribute("data-negative")).toBe(true);
    expect(el.className).toContain("text-destructive");
    expect(el.className).toContain("tabular-nums");
  });

  it("drops the color in the plain tone but keeps the minus sign", () => {
    render(<Money cents={-20_000} tone="plain" />);
    const el = screen.getByText("−$200.00");
    expect(el.className).not.toContain("text-destructive");
    expect(el.hasAttribute("data-negative")).toBe(true);
  });

  it("shows a positive and zero without a marker", () => {
    render(
      <>
        <Money cents={240_000} />
        <Money cents={0} />
      </>,
    );
    expect(screen.getByText("$2,400.00").hasAttribute("data-negative")).toBe(false);
    expect(screen.getByText("$0.00").hasAttribute("data-negative")).toBe(false);
  });
});
