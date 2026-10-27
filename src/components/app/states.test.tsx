// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState, ErrorState, FeatureOff, PageNotFound } from "./states";

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

  it("shows the demo budget state in plain words", () => {
    render(<ErrorState category="budget" />);
    expect(screen.getByText("The demo budget is used up")).toBeTruthy();
    expect(
      screen.getByText("The agent pauses until the budget is raised. Your data and every payout are unchanged."),
    ).toBeTruthy();
  });

  it("says a paused job waits for an admin, and where to resume it", () => {
    render(<ErrorState category="job_cap" />);
    expect(screen.getByText("This job paused")).toBeTruthy();
    expect(
      screen.getByText(
        "It used more than its hourly budget. Nothing was lost or sent. An admin can resume it under Settings, Models and spend.",
      ),
    ).toBeTruthy();
  });

  it("falls back to the unknown copy for a category it does not know", () => {
    render(<ErrorState category="constructor" />);
    expect(screen.getByText("Something failed and the cause is not known")).toBeTruthy();
  });
});

describe("EmptyState", () => {
  it("is a plain line by default and a heading when asked", () => {
    const { rerender } = render(<EmptyState title="No invoices yet" />);
    expect(screen.queryByRole("heading")).toBeNull();
    rerender(<EmptyState title="No invoices yet" titleAs="h2" />);
    expect(screen.getByRole("heading", { level: 2, name: "No invoices yet" })).toBeTruthy();
  });
});

describe("FeatureOff", () => {
  it("says what is off, that nothing changed, and links Home", () => {
    render(<FeatureOff name="Voice notes" plural />);
    expect(screen.getByRole("heading", { level: 2, name: "Voice notes are off for this carrier" })).toBeTruthy();
    expect(screen.getByText("Nothing here has changed. Ask your administrator to switch it on.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
  });

  it("uses is for one thing", () => {
    render(<FeatureOff name="Pay sweep" />);
    expect(screen.getByRole("heading", { name: "Pay sweep is off for this carrier" })).toBeTruthy();
  });
});

describe("PageNotFound", () => {
  it("is the page heading, says nothing changed, and links Home", () => {
    render(<PageNotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "That page is not here" })).toBeTruthy();
    expect(
      screen.getByText("The address may be wrong, or the page may be switched off for this carrier. Nothing changed."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
    expect(document.body.textContent).not.toContain("404");
  });
});
