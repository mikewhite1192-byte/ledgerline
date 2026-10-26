// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorState } from "./states";

afterEach(cleanup);

describe("ErrorState", () => {
  it("announces a failure as an alert by default", () => {
    render(<ErrorState category="timeout" />);
    expect(screen.getByRole("alert").textContent).toContain("That took too long to load");
  });

  it("stays quiet when it is a specimen on show", () => {
    render(<ErrorState category="timeout" announce={false} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("That took too long to load")).toBeTruthy();
  });

  it("falls back to the unknown copy for a category it does not know", () => {
    render(<ErrorState category="constructor" />);
    expect(screen.getByText("Something failed and the cause is not known")).toBeTruthy();
  });
});
