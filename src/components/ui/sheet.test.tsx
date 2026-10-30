// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "./sheet";

// jsdom has no modal dialog, so these stand in for the browser's: opening sets the attribute,
// closing an open dialog clears it and fires the close event.
// show() is the non-modal one, beside the page.
const opened: string[] = [];
beforeEach(() => {
  opened.length = 0;
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    opened.push("modal");
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    opened.push("beside");
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

// Closes the way the app does: onClose sets open to false.
function Harness({ onClose, modal }: { onClose: () => void; modal?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <Sheet
      open={open}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
      label="Menu"
      modal={modal}
    >
      <p>Inside</p>
    </Sheet>
  );
}

describe("Sheet", () => {
  it("calls onClose once when the close button is pressed", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Menu" }) as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(false);
  });

  it("calls onClose once when the dimmed page is clicked", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Menu" }) as HTMLDialogElement;
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(false);
  });

  it("stays open on a click inside the panel", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByText("Inside"));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("dialog", { name: "Menu" }) as HTMLDialogElement).open).toBe(true);
  });

  it("opens as a modal unless told to open beside the page", () => {
    render(<Harness onClose={() => undefined} />);
    expect(opened).toEqual(["modal"]);
  });
});

describe("Sheet beside the page", () => {
  it("opens without dimming the page, and a click outside its panel leaves it open", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} modal={false} />);
    expect(opened).toEqual(["beside"]);
    const dialog = screen.getByRole("dialog", { name: "Menu" }) as HTMLDialogElement;
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
  });

  it("closes on Esc pressed inside it, once", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} modal={false} />);
    fireEvent.keyDown(screen.getByText("Inside"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect((screen.queryByRole("dialog", { name: "Menu" }) as HTMLDialogElement | null)?.open ?? false).toBe(false);
  });

  it("stays open on an Esc that only cancels a half-typed word", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} modal={false} />);
    fireEvent.keyDown(screen.getByText("Inside"), { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("dialog", { name: "Menu" }) as HTMLDialogElement).open).toBe(true);
  });

  it("names its close button as asked and slides in from the right", () => {
    render(
      <Sheet open onClose={() => undefined} label="Agent" side="right" modal={false} closeLabel="Close the agent">
        <p>Inside</p>
      </Sheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Agent" });
    expect(dialog.className).toContain("right-0");
    expect(screen.getByRole("button", { name: "Close the agent" })).toBeTruthy();
  });
});
