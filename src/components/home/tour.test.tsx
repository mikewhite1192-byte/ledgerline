// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelContext } from "@/components/agent/panel-context";
import type { TourStep } from "@/lib/tour/steps";
import { Tour } from "./tour";

// The walkthrough panel from fixed steps: it opens on the first, Next and Back move, Skip and Done
// close it, a read that failed shows as a notice, and "Ask about this" fills the agent's box with
// the step's question without sending it.

afterEach(cleanup);

const STEPS: TourStep[] = [
  {
    id: "working",
    title: "Your AI accountant is already working",
    lines: [{ text: "The desk last checked in Nov 10, 2026, 9:00 AM CST and finished 4 things today." }],
    link: { href: "#today", label: "See today" },
    ask: "What has the desk done for us today?",
  },
  {
    id: "pay_week",
    title: "Paystubs this week",
    lines: [{ text: "Could not read this week's paystubs.", unread: true }],
    link: { href: "/settlements", label: "Open Pay" },
    ask: "Who has a problem on this week's paystub?",
  },
  { id: "ask", title: "Ask the agent", lines: [{ text: "Ask in plain English." }], ask: "Who owes us money past 60 days?" },
];

const panel = () => screen.getByRole("region", { name: "Walkthrough" });
const title = () => within(panel()).getByRole("heading").textContent;
const button = (name: string) => within(panel()).getByRole("button", { name });

describe("Tour", () => {
  it("opens on the first step, and Next and Back move one step at a time", () => {
    render(<Tour steps={STEPS} footer="Written from today's numbers." />);
    expect(title()).toBe("Your AI accountant is already working");
    expect(panel().textContent).toContain("Walkthrough, step 1 of 3");
    expect((button("Back") as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel()).getByRole("link", { name: "See today" }).getAttribute("href")).toBe("#today");
    expect(panel().textContent).toContain("Written from today's numbers.");
    fireEvent.click(button("Next"));
    expect(title()).toBe("Paystubs this week");
    expect(panel().textContent).toContain("Walkthrough, step 2 of 3");
    // A read that failed is a notice, never a figure.
    expect(within(panel()).getByRole("status").textContent).toBe("Could not read this week's paystubs.");
    fireEvent.click(button("Back"));
    expect(title()).toBe("Your AI accountant is already working");
  });

  it("closes on Done at the last step", () => {
    render(<Tour steps={STEPS} footer="" />);
    fireEvent.click(button("Next"));
    fireEvent.click(button("Next"));
    expect(title()).toBe("Ask the agent");
    expect(within(panel()).queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.click(button("Done"));
    expect(screen.queryByRole("region", { name: "Walkthrough" })).toBeNull();
  });

  it("closes on Skip from any step", () => {
    render(<Tour steps={STEPS} footer="" />);
    fireEvent.click(button("Next"));
    fireEvent.click(button("Skip"));
    expect(screen.queryByRole("region", { name: "Walkthrough" })).toBeNull();
  });

  it("shows nothing with no steps", () => {
    render(<Tour steps={[]} footer="" />);
    expect(screen.queryByRole("region", { name: "Walkthrough" })).toBeNull();
  });

  it("puts the step's question in the agent's box, and has no Ask without the agent card", () => {
    const open = vi.fn();
    render(
      <PanelContext.Provider value={{ open }}>
        <Tour steps={STEPS} footer="" />
      </PanelContext.Provider>,
    );
    fireEvent.click(button("Ask about this: Your AI accountant is already working"));
    expect(open).toHaveBeenCalledWith({ draft: "What has the desk done for us today?" });
    // The panel stays open on its step.
    expect(title()).toBe("Your AI accountant is already working");
    cleanup();
    render(<Tour steps={STEPS} footer="" />);
    expect(within(panel()).queryByRole("button", { name: /^Ask about this/ })).toBeNull();
  });

  it("is reachable from the keyboard: every control is a real link or button, in reading order", () => {
    const open = vi.fn();
    render(
      <PanelContext.Provider value={{ open }}>
        <Tour steps={STEPS} footer="" />
      </PanelContext.Provider>,
    );
    const controls = Array.from(panel().querySelectorAll<HTMLElement>("a[href], button"));
    expect(controls.map((c) => c.textContent)).toEqual([
      "See today",
      "Ask about this: Your AI accountant is already working",
      "Skip",
      "Back",
      "Next",
    ]);
    for (const c of controls) expect(c.tabIndex, c.textContent ?? "").toBe(0);
    for (const c of controls.filter((x) => x.tagName === "BUTTON")) expect(c.getAttribute("type")).toBe("button");
    const next = button("Next");
    next.focus();
    expect(document.activeElement).toBe(next);
  });
});
