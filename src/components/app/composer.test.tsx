// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";

afterEach(cleanup);

const SUGGESTIONS = [
  { id: "past-60", label: "Who owes us money past 60 days?", reason: "Lists late invoices by customer." },
  { id: "pay-run-cost", label: "What will Friday's pay run cost?", reason: "Adds up this week's net pay." },
];

const box = () => screen.getByRole("textbox", { name: "Your question" }) as HTMLTextAreaElement;
const plus = () => screen.getByRole("button", { name: "More ways to ask" });

describe("the agent card's pill question box", () => {
  it("sends with the round arrow, which stays off while the box is blank", () => {
    const sent: string[] = [];
    render(<Composer variant="pill" onSubmit={(t) => sent.push(t)} />);
    expect(box().placeholder).toBe("Ask a question or give a command");
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(box(), { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    fireEvent.change(box(), { target: { value: "  Who is late?  " } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(sent).toEqual(["Who is late?"]);
    expect(box().value).toBe("");
  });

  it("says Asking while a question is out", () => {
    render(<Composer variant="pill" onSubmit={() => undefined} pending />);
    expect(screen.getByRole("button", { name: "Asking" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("offers the suggested questions behind the +, and a pick goes to the chat", () => {
    const picked: string[] = [];
    render(
      <Composer
        variant="pill"
        onSubmit={() => undefined}
        menu={{ suggestions: SUGGESTIONS, onPick: (id) => picked.push(id) }}
      />,
    );
    expect(plus().getAttribute("aria-haspopup")).toBe("menu");
    expect(plus().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(plus());
    expect(plus().getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "More ways to ask" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(SUGGESTIONS.map((s) => s.label));
    // The upload link shows only while the documents page is on.
    expect(within(menu).queryByRole("menuitem", { name: "Upload a document" })).toBeNull();
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.click(items[1]);
    expect(picked).toEqual(["pay-run-cost"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the menu on Esc and uses the key up, so the card around it stays open", () => {
    const outer = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    render(
      <div onKeyDown={outer}>
        <Composer variant="pill" onSubmit={() => undefined} menu={{ suggestions: SUGGESTIONS, onPick: () => undefined }} />
      </div>,
    );
    fireEvent.click(plus());
    const item = within(screen.getByRole("menu")).getAllByRole("menuitem")[0];
    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(plus());
    expect(outer).toHaveBeenCalledTimes(1);
    expect(outer.mock.results[0].value).toBe(true);
    // With the menu closed, Esc is left for the card.
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(outer.mock.results[1].value).toBe(false);
  });

  it("closes the menu on a click outside it", () => {
    render(
      <>
        <p>Outside</p>
        <Composer variant="pill" onSubmit={() => undefined} menu={{ suggestions: SUGGESTIONS, onPick: () => undefined }} />
      </>,
    );
    fireEvent.click(plus());
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the menu when the cursor tabs out of it, but not when it moves inside or nowhere", () => {
    render(
      <>
        <Composer variant="pill" onSubmit={() => undefined} menu={{ suggestions: SUGGESTIONS, onPick: () => undefined }} />
        <button type="button">After</button>
      </>,
    );
    fireEvent.click(plus());
    const [first, second] = screen.getAllByRole("menuitem");
    fireEvent.blur(first, { relatedTarget: second });
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.blur(first, { relatedTarget: null });
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.blur(first, { relatedTarget: screen.getByRole("button", { name: "After" }) });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("links to the documents page while documents are on, and keeps only that when the agent cannot answer", () => {
    render(<Composer variant="pill" menu={{ suggestions: SUGGESTIONS, documentsHref: "/documents" }} />);
    fireEvent.click(plus());
    const menu = screen.getByRole("menu");
    const upload = within(menu).getByRole("menuitem", { name: "Upload a document" });
    expect(upload.getAttribute("href")).toBe("/documents");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
  });

  it("leaves the + out when there is nothing to offer, and the wide box never has one", () => {
    const { unmount } = render(<Composer variant="pill" onSubmit={() => undefined} menu={{ suggestions: [] }} />);
    expect(screen.queryByRole("button", { name: "More ways to ask" })).toBeNull();
    unmount();
    render(<Composer onSubmit={() => undefined} menu={{ suggestions: SUGGESTIONS, onPick: () => undefined }} />);
    expect(screen.queryByRole("button", { name: "More ways to ask" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" }).textContent).toBe("Send");
  });
});
