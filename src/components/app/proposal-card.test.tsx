// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalCard, type ProposalAudit, type ProposalCardProps, type ProposalStatus } from "./proposal-card";

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

  it("offers one Resume on an approved card that stopped before it finished, and never Reject", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ProposalCard {...card} status="approved" canResume onApprove={onApprove} onReject={onReject} />);
    expect(screen.queryAllByRole("button").map((b) => b.textContent)).toEqual(["Resume"]);
    expect(button("Reject")).toBeNull();
    expect(screen.getByText(/Resume picks it up where it stopped/)).toBeTruthy();
    // One click: the approval and its confirm already stand.
    fireEvent.click(button("Resume")!);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("p-1");
    expect(onReject).not.toHaveBeenCalled();
  });

  it("offers no Resume without canResume, and none on any status but approved", () => {
    const { unmount } = render(<ProposalCard {...card} status="approved" />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    unmount();
    const others: ProposalStatus[] = ["executing", "rejected", "done", "failed", "unknown"];
    for (const status of others) {
      const view = render(<ProposalCard {...card} status={status} canResume />);
      expect(screen.queryAllByRole("button"), status).toHaveLength(0);
      view.unmount();
    }
  });

  it("disables Resume while it is in flight", () => {
    render(<ProposalCard {...card} status="approved" canResume pending />);
    expect((button(/Resuming/) as HTMLButtonElement).disabled).toBe(true);
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

  it("shows the detail line under the title only when there is one", () => {
    const { unmount } = render(<ProposalCard {...card} />);
    expect(screen.queryByText(/cap left after this/)).toBeNull();
    unmount();
    render(<ProposalCard {...card} detail="Load BR-L10001: $145.00 of $600.00 cap left after this." />);
    expect(screen.getByText("Load BR-L10001: $145.00 of $600.00 cap left after this.")).toBeTruthy();
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

  it("shows where the money lands under the amount, with Test mode, and asks the card question", () => {
    render(
      <ProposalCard
        {...card}
        destination={{ label: "To fuel card ···· 4417", testMode: true }}
        confirmQuestion="Pay $200.00 to Sample Driver's fuel card ···· 4417? Test mode."
      />,
    );
    const line = screen.getByText("To fuel card ···· 4417 · Test mode");
    // One small line that may wrap at phone width: nothing in it refuses to break.
    expect(line.closest("p")?.className).not.toContain("nowrap");
    expect(line.closest("p")?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(button("Approve $200.00")!);
    expect(screen.getByText("Pay $200.00 to Sample Driver's fuel card ···· 4417? Test mode.")).toBeTruthy();
  });

  it("says no card is on file without Test mode, and shows no line when there is no destination", () => {
    const { unmount } = render(
      <ProposalCard {...card} destination={{ label: "No fuel card on file", testMode: false }} />,
    );
    expect(screen.getByText("No fuel card on file")).toBeTruthy();
    expect(screen.queryByText(/Test mode/)).toBeNull();
    unmount();
    render(<ProposalCard {...card} />);
    expect(screen.queryByText(/fuel card/i)).toBeNull();
  });
});

describe("ProposalCard with the auditor's check", () => {
  it("shows a fixed badge per verdict, and the plain sentence for every verdict but pass", () => {
    const cases: [ProposalAudit["state"], string][] = [
      ["pass", "Checked by Muse Wonder: pass"],
      ["concerns", "Muse Wonder has concerns"],
      ["block", "Muse Wonder blocked this"],
      ["unknown", "Not checked"],
      ["budget", "Not checked: demo budget reached"],
      ["off", "Auditor off"],
    ];
    for (const [state, label] of cases) {
      const { unmount } = render(<ProposalCard {...card} audit={{ state, text: "A source record is missing." }} />);
      expect(screen.getByText(label), state).toBeTruthy();
      expect(screen.queryByText("A source record is missing.") !== null, state).toBe(state !== "pass" && state !== "budget");
      unmount();
    }
  });

  it("says the data is unchanged when the demo budget stopped the check", () => {
    render(<ProposalCard {...card} audit={{ state: "budget" }} />);
    expect(screen.getByText("The auditor could not check this proposal. Your data is unchanged.")).toBeTruthy();
    expect(button("Approve $200.00")).toBeTruthy();
  });

  it("says Muse Wonder is checking, as a status", () => {
    render(<ProposalCard {...card} audit={{ state: "checking" }} />);
    expect(screen.getByRole("status").textContent).toContain("Muse Wonder is checking...");
  });

  it("asks the given confirm question on concerns", () => {
    const onApprove = vi.fn();
    render(
      <ProposalCard
        {...card}
        audit={{ state: "concerns", text: "The amount does not match the records." }}
        confirmQuestion="Muse Wonder has concerns. Approve anyway?"
        onApprove={onApprove}
      />,
    );
    fireEvent.click(button("Approve $200.00")!);
    expect(screen.getByText("Muse Wonder has concerns. Approve anyway?")).toBeTruthy();
    fireEvent.click(button("Confirm")!);
    expect(onApprove).toHaveBeenCalledWith("p-1");
  });

  it("offers no Approve on a block, only a reason box, a counter and Override", () => {
    render(<ProposalCard {...card} audit={{ state: "block", text: "The amount does not match the records." }} />);
    expect(button("Approve $200.00")).toBeNull();
    expect(button("Reject")).toBeTruthy();
    const box = screen.getByLabelText("Why approve it anyway? (10 to 240 characters)");
    expect(screen.getByText("0 of 240")).toBeTruthy();
    const override = button("Override and approve") as HTMLButtonElement;
    expect(override.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "too short" } });
    expect(screen.getByText("9 of 240")).toBeTruthy();
    expect(override.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "          " } });
    expect(override.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "a".repeat(241) } });
    expect(screen.getByText("241 of 240")).toBeTruthy();
    expect(override.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "Driver showed the receipt" } });
    expect(override.disabled).toBe(false);
  });

  it("sends the trimmed reason only from the override confirm", () => {
    const onApprove = vi.fn();
    render(<ProposalCard {...card} audit={{ state: "block" }} onApprove={onApprove} />);
    fireEvent.change(screen.getByLabelText(/Why approve it anyway/), { target: { value: "  Driver showed the receipt  " } });
    fireEvent.click(button("Override and approve")!);
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByText("Approve over Muse Wonder's block?")).toBeTruthy();
    expect(document.activeElement).toBe(button("Cancel"));

    fireEvent.click(button("Cancel")!);
    expect(button("Confirm")).toBeNull();
    expect(document.activeElement).toBe(button("Override and approve"));

    fireEvent.click(button("Override and approve")!);
    fireEvent.click(button("Confirm")!);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("p-1", "Driver showed the receipt");
  });

  it("keeps Confirm disabled on a block that opens with the confirm row and no reason", () => {
    const onApprove = vi.fn();
    render(<ProposalCard {...card} audit={{ state: "block" }} onApprove={onApprove} initialConfirming />);
    const confirm = button("Confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("shows who overrode a block, when and why", () => {
    render(
      <ProposalCard
        {...card}
        status="approved"
        audit={{ state: "block", override: { reason: "Driver showed the receipt", byLabel: "an admin", at: "Oct 28, 2026, 3:00 PM UTC" } }}
      />,
    );
    expect(screen.getByText("Muse Wonder blocked this")).toBeTruthy();
    expect(screen.getByText("Overridden by an admin on Oct 28, 2026, 3:00 PM UTC: Driver showed the receipt")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
