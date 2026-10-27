// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VisuallyHidden } from "./visually-hidden";

afterEach(cleanup);

describe("VisuallyHidden", () => {
  it("stays hidden when a caller adds its own class", () => {
    render(<VisuallyHidden className="font-semibold">Read aloud only</VisuallyHidden>);
    const span = screen.getByText("Read aloud only");
    expect(span.classList.contains("sr-only")).toBe(true);
    expect(span.classList.contains("font-semibold")).toBe(true);
  });
});
