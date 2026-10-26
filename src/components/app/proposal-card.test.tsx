// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalCard, type ProposalCardProps, type ProposalStatus } from "./proposal-card";

afterEach(cleanup);

const card: ProposalCardProps = {
  id: "p-1",
  title: "Pay a $200.00 advance to Sample Driver",
  impact: { cents: 20_000, direction: "out" },
  reasons: [{ text: "Earned and unpaid this week: $2,400.00", source: { table: "loads", id: "L-1" } }],
  sources: [{ table: "drivers", id: "D-1" }],
  status: "proposed",
  confirmQuestion: "Pay $200.00 to Sample Driver?",
};

const button = (name: string | RegExp) => screen.queryByRole("button", { name });

describe("ProposalCard", () => {
  it("shows Approve and Reject only while the proposal waits", () => {
    const others: ProposalStatus[] = ["approved", "rejected", "executing", "done", "failed", "unknown"];
    for (const status of others) {
      const { unmount } = render(<ProposalCard {...card} status={status} />);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      unmount();
    }
    render(<ProposalCard {...card} />);
    expect(button("Approve $200.00")).toBeTruthy();
    expect(button("Reject")).toBeTruthy();
  });

  it("asks once more and approves only on Confirm", () => {
    const onApprove = vi.fn();
    render(<ProposalCard {...card} onApprove={onApprove} />);
    fireEvent.click(button("Approve $200.00")!);
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm approval" })).toBeTruthy();
    expect(screen.getByText("Pay $200.00 to Sample Driver?")).toBeTruthy();
    expect(document.activeElement).toBe(button("Cancel"));

    fireEvent.click(button("Cancel")!);
    expect(onApprove).not.toHaveBeenCalled();
    expect(button("Confirm")).toBeNull();

    fireEvent.click(button("Approve $200.00")!);
    fireEvent.click(button("Confirm")!);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("p-1");
  });

  it("disables every button while a decision is in flight", () => {
    const { unmount } = render(<ProposalCard {...card} pending />);
    expect((button("Approve $200.00") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Reject") as HTMLButtonElement).disabled).toBe(true);
    unmount();

    render(<ProposalCard {...card} pending initialConfirming />);
    expect((button("Cancel") as HTMLButtonElement).disabled).toBe(true);
    expect((button(/Approving/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says it is waiting on the read-back when the outcome is unknown", () => {
    render(<ProposalCard {...card} status="unknown" />);
    expect(screen.getByText("Sent, waiting on the read-back.")).toBeTruthy();
    expect(screen.getByText("Outcome unknown")).toBeTruthy();
  });

  it("shows money going out as a negative and links each reason to its record", () => {
    render(<ProposalCard {...card} />);
    expect(screen.getByText("−$200.00").hasAttribute("data-negative")).toBe(true);
    expect(screen.getByRole("link", { name: "Load L-1" }).getAttribute("href")).toBe("/records/loads/L-1");
    expect(screen.getByRole("link", { name: "Driver D-1" }).getAttribute("href")).toBe("/records/drivers/D-1");
  });

  it("shows money coming in with a plus sign", () => {
    render(<ProposalCard {...card} impact={{ cents: 320_000, direction: "in" }} />);
    expect(screen.getByText("+$3,200.00")).toBeTruthy();
  });
});
