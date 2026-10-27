// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "./sheet";

// jsdom has no modal dialog, so these stand in for the browser's: opening sets the attribute,
// closing an open dialog clears it and fires the close event.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
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
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

// Closes the way the app does: onClose sets open to false.
function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <Sheet
      open={open}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
      label="Menu"
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
});
