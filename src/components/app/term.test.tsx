// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TERM_IDS, TERMS, termHelp } from "@/lib/format/terms";
import { Term } from "./term";

afterEach(cleanup);

const HELP = "The pay or price for the haul itself, before fuel and extras.";

function word() {
  return screen.getByRole("button", { name: "Linehaul" });
}
function help() {
  return screen.getByRole("tooltip", { hidden: true });
}

describe("Term", () => {
  it("names its help as the word's description, shown or not", () => {
    render(<Term id="linehaul">Linehaul</Term>);
    expect(help().hidden).toBe(true);
    expect(help().textContent).toBe(HELP);
    expect(word().getAttribute("aria-describedby")).toBe(help().id);
  });

  it("shows the help on keyboard focus and hides it on blur", () => {
    render(<Term id="linehaul">Linehaul</Term>);
    fireEvent.focus(word());
    expect(help().hidden).toBe(false);
    fireEvent.blur(word());
    expect(help().hidden).toBe(true);
  });

  it("hides the help on Escape without moving focus, and shows it again on the next focus", () => {
    render(<Term id="linehaul">Linehaul</Term>);
    act(() => word().focus());
    expect(help().hidden).toBe(false);
    fireEvent.keyDown(word(), { key: "Escape" });
    expect(help().hidden).toBe(true);
    expect(document.activeElement).toBe(word());
    act(() => word().blur());
    act(() => word().focus());
    expect(help().hidden).toBe(false);
  });

  it("shows the help on mouse hover and hides it when the mouse leaves", () => {
    const { container } = render(<Term id="linehaul">Linehaul</Term>);
    const wrap = container.firstElementChild as HTMLElement;
    fireEvent.pointerEnter(wrap, { pointerType: "mouse" });
    expect(help().hidden).toBe(false);
    fireEvent.pointerLeave(wrap, { pointerType: "mouse" });
    expect(help().hidden).toBe(true);
  });

  it("toggles the help on a tap: one tap shows it, the next hides it", () => {
    render(<Term id="linehaul">Linehaul</Term>);
    fireEvent.pointerDown(word(), { pointerType: "touch" });
    fireEvent.focus(word());
    fireEvent.click(word());
    expect(help().hidden).toBe(false);
    fireEvent.pointerDown(word(), { pointerType: "touch" });
    fireEvent.click(word());
    expect(help().hidden).toBe(true);
  });
});

describe("terms", () => {
  it("has one plain sentence for every word, with no em dash and no underscore", () => {
    expect(TERM_IDS.length).toBeGreaterThan(20);
    for (const id of TERM_IDS) {
      const text = termHelp(id);
      expect(text, id).toBe(TERMS[id]);
      expect(text, id).toMatch(/^[A-Z].*\.$/);
      expect(text, id).not.toMatch(/\u2014|_/);
    }
  });
});
