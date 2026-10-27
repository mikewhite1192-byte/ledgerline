// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmPanel } from "./confirm-panel";

afterEach(cleanup);

describe("ConfirmPanel", () => {
  it("asks the question, says what happens next, and starts on Keep reviewing", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmPanel
        question="Approve 2 paystubs?"
        summary="2 drivers, $2,469.00 in total."
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
    expect(screen.getByText("2 drivers, $2,469.00 in total.")).toBeTruthy();
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

  it("holds both buttons while the confirm is pending", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmPanel question="Approve?" next="It is paid by test payout." pending onConfirm={onConfirm} onCancel={() => {}} />,
    );
    expect((screen.getByRole("button", { name: "Keep reviewing" }) as HTMLButtonElement).disabled).toBe(true);
    const buttons = screen.getAllByRole("button") as HTMLButtonElement[];
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });
});
