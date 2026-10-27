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

  it("puts focus back on Approve after Cancel, so keyboard users keep their place", () => {
    const { unmount } = render(<ProposalCard {...card} />);
    fireEvent.click(button("Approve $200.00")!);
    expect(document.activeElement).toBe(button("Cancel"));
    fireEvent.click(button("Cancel")!);
    expect(document.activeElement).toBe(button("Approve $200.00"));
    unmount();

    // A card that opens with the confirm row showing does the same.
    render(<ProposalCard {...card} initialConfirming />);
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(button("Cancel")!);
    expect(document.activeElement).toBe(button("Approve $200.00"));
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

  it("says money moved only once the proposal is done", () => {
    const cases: [ProposalStatus, "in" | "out", string][] = [
      ["proposed", "out", "Would pay out"],
      ["approved", "in", "Would come in"],
      ["failed", "out", "Not paid"],
      ["failed", "in", "Not received"],
      ["rejected", "out", "Not paid"],
      ["unknown", "out", "Pay out, not confirmed"],
      ["unknown", "in", "Coming in, not confirmed"],
      ["done", "out", "Paid out"],
      ["done", "in", "Came in"],
    ];
    for (const [status, direction, label] of cases) {
      const { unmount } = render(<ProposalCard {...card} status={status} impact={{ cents: 20_000, direction }} />);
      expect(screen.getByText(label), `${status} ${direction}`).toBeTruthy();
      unmount();
    }
  });

  it("lets an explicit label win over the status label", () => {
    render(<ProposalCard {...card} status="failed" impact={{ cents: 20_000, direction: "out", label: "Applies to INV-1" }} />);
    expect(screen.getByText("Applies to INV-1")).toBeTruthy();
    expect(screen.queryByText("Not paid")).toBeNull();
  });

  it("shows the amount a no-money move carries but leaves it off Approve", () => {
    render(<ProposalCard {...card} impact={{ cents: 185_000, direction: "none" }} confirmQuestion={undefined} />);
    expect(screen.getByText("No money moves")).toBeTruthy();
    const amount = screen.getByText("$1,850.00");
    expect(amount.hasAttribute("data-negative")).toBe(false);
    expect(button("Approve $1,850.00")).toBeNull();
    fireEvent.click(button("Approve")!);
    expect(screen.getByText("Approve this?")).toBeTruthy();
  });

  it("never asks to approve $0.00", () => {
    render(<ProposalCard {...card} impact={{ cents: 0, direction: "out" }} confirmQuestion={undefined} />);
    expect(button("Approve $0.00")).toBeNull();
    fireEvent.click(button("Approve")!);
    expect(screen.getByText("Approve this?")).toBeTruthy();
    expect(screen.queryByText("Approve $0.00?")).toBeNull();
  });

  it("keeps a given question even when no money moves", () => {
    render(
      <ProposalCard {...card} impact={{ cents: 0, direction: "none" }} confirmQuestion="Move it to INV-2?" initialConfirming />,
    );
    expect(screen.getByText("Move it to INV-2?")).toBeTruthy();
    expect(screen.queryByText("Approve this?")).toBeNull();
  });

  it("shows a record the link rules do not know as plain text, without a link", () => {
    render(
      <ProposalCard
        {...card}
        reasons={[{ text: "Applied twice", source: { table: "users", id: "U-1" } }]}
        sources={[{ table: "loads", id: "" }]}
      />,
    );
    expect(screen.getByText("Users U-1").closest("a")).toBeNull();
    expect(screen.getByText("Load").closest("a")).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("says an expired proposal changed nothing and offers no buttons", () => {
    render(<ProposalCard {...card} status="expired" />);
    expect(screen.getByText("Expired before anyone approved it. Nothing changed.")).toBeTruthy();
    expect(screen.getByText("Not paid")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows a flag note above the buttons and asks the flag question on confirm", () => {
    render(
      <ProposalCard
        {...card}
        flagNote="Read with care: the message behind this was flagged for a claim of authority."
        confirmQuestion="This came from a message that failed screening. Approve anyway?"
      />,
    );
    expect(screen.getByRole("note").textContent).toContain("a claim of authority");
    fireEvent.click(button("Approve $200.00")!);
    expect(screen.getByText("This came from a message that failed screening. Approve anyway?")).toBeTruthy();
  });

  it("says nothing changed when a proposal is rejected", () => {
    render(<ProposalCard {...card} status="rejected" />);
    expect(screen.getByText("Rejected. Nothing changed.")).toBeTruthy();
  });
});
