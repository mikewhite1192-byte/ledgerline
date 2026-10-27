// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmPanel } from "./confirm-panel";

afterEach(cleanup);

// The count and total line, whose dollar amount is its own span.
const line = (text: string) => screen.getByText((_, el) => el?.tagName === "P" && el.textContent === text);

describe("ConfirmPanel", () => {
  it("asks the question, says what happens next, and starts on Keep reviewing", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmPanel
        question="Approve 2 paystubs?"
        count="2 drivers"
        items={[
          { key: "a", label: "Driver one", cents: 123450 },
          { key: "b", label: "Driver two", cents: 123450 },
        ]}
        next="Each driver's pay goes to their bank by test payout."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole("group", { name: "Approve 2 paystubs?" })).toBeTruthy();
    expect(line("2 drivers, $2,469.00 in total.")).toBeTruthy();
    expect(screen.getByText("Each driver's pay goes to their bank by test payout.")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Included" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep reviewing" }));

    fireEvent.click(screen.getByRole("button", { name: "Keep reviewing" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("lists nothing for a single item and takes its own button words", () => {
    render(
      <ConfirmPanel
        question="Reject this advance?"
        items={[{ key: "a", label: "Advance A-1", cents: 20000 }]}
        next="Nothing is paid. The driver can ask again."
        confirmLabel="Reject"
        tone="destructive"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("adds the total from the items itself, so a caller's total can never disagree with the list", () => {
    render(
      <ConfirmPanel
        question="Approve 2 paystubs?"
        count="2 drivers"
        summary="2 drivers, $9,999.00 in total."
        items={[
          { key: "a", label: "Driver one", cents: 123450 },
          { key: "b", label: "Driver two", cents: 100 },
        ]}
        next="Each driver's pay goes to their bank by test payout."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(line("2 drivers, $1,235.50 in total.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("$9,999.00");
    cleanup();

    render(
      <ConfirmPanel
        question="Approve 3 invoices?"
        items={[
          { key: "a", label: "Invoice one", cents: 50000 },
          { key: "b", label: "Invoice two", cents: 25000 },
          { key: "c", label: "Invoice three", cents: 25 },
        ]}
        next="Each invoice is posted to QuickBooks."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(line("3 items, $750.25 in total.")).toBeTruthy();
  });

  it("shows the caller's line only when an item has no amount", () => {
    render(
      <ConfirmPanel
        question="Approve 2 notes?"
        summary="2 notes, one for each driver."
        items={[
          { key: "a", label: "Note one" },
          { key: "b", label: "Note two", cents: 100 },
        ]}
        next="Each driver sees the note above their paystub."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("2 notes, one for each driver.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("in total");
  });

  it("holds both buttons while the confirm is pending", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmPanel question="Approve?" next="It is paid by test payout." pending onConfirm={onConfirm} onCancel={() => {}} />,
    );
    expect((screen.getByRole("button", { name: "Keep reviewing" }) as HTMLButtonElement).disabled).toBe(true);
    const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it("gives Keep reviewing focus when a pending it opened with ends", () => {
    const panel = (pending: boolean) => (
      <ConfirmPanel question="Approve?" next="It is paid by test payout." pending={pending} onConfirm={() => {}} onCancel={() => {}} />
    );
    const { rerender } = render(panel(true));
    const cancel = screen.getByRole("button", { name: "Keep reviewing" });
    // A disabled button cannot hold focus.
    expect(document.activeElement).not.toBe(cancel);
    rerender(panel(false));
    expect(document.activeElement).toBe(cancel);
  });

  it("brings focus back to Keep reviewing after a pending confirm, never pulling it from elsewhere", () => {
    const panel = (pending: boolean) => (
      <>
        <input aria-label="Elsewhere" />
        <ConfirmPanel question="Approve?" next="It is paid by test payout." pending={pending} onConfirm={() => {}} onCancel={() => {}} />
      </>
    );
    const { rerender } = render(panel(false));
    const cancel = screen.getByRole("button", { name: "Keep reviewing" });
    expect(document.activeElement).toBe(cancel);

    // Confirm is pressed and the confirm ends without closing the panel (it failed, say).
    screen.getByRole("button", { name: "Confirm" }).focus();
    rerender(panel(true));
    rerender(panel(false));
    expect(document.activeElement).toBe(cancel);

    // Focus that was lost to the page comes back too.
    cancel.blur();
    expect(document.activeElement).toBe(document.body);
    rerender(panel(true));
    rerender(panel(false));
    expect(document.activeElement).toBe(cancel);

    // A person who moved on keeps their place.
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    rerender(panel(true));
    elsewhere.focus();
    rerender(panel(false));
    expect(document.activeElement).toBe(elsewhere);
  });
});
