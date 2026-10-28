// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIRM_NEXT,
  ProposalCard,
  REJECT_NEXT,
  type ProposalAudit,
  type ProposalCardProps,
  type ProposalStatus,
} from "./proposal-card";

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
    expect(document.activeElement).toBe(button("Keep reviewing"));

    fireEvent.click(button("Keep reviewing")!);
    expect(onApprove).not.toHaveBeenCalled();
    expect(button("Confirm")).toBeNull();

    fireEvent.click(button("Approve $200.00")!);
    fireEvent.click(button("Confirm")!);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("p-1");
  });

  it("puts focus back on Approve after Keep reviewing, so keyboard users keep their place", () => {
    const { unmount } = render(<ProposalCard {...card} />);
    fireEvent.click(button("Approve $200.00")!);
    expect(document.activeElement).toBe(button("Keep reviewing"));
    fireEvent.click(button("Keep reviewing")!);
    expect(document.activeElement).toBe(button("Approve $200.00"));
    unmount();

    // A card that opens with the confirm row showing does the same.
    render(<ProposalCard {...card} initialConfirming />);
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(button("Keep reviewing")!);
    expect(document.activeElement).toBe(button("Approve $200.00"));
  });

  it("disables every button while a decision is in flight", () => {
    const { unmount } = render(<ProposalCard {...card} pending />);
    expect((button("Approve $200.00") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Reject") as HTMLButtonElement).disabled).toBe(true);
    unmount();

    render(<ProposalCard {...card} pending initialConfirming />);
    expect((button("Keep reviewing") as HTMLButtonElement).disabled).toBe(true);
    expect((button(/Approving/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says it is waiting for confirmation when the outcome is unknown", () => {
    render(<ProposalCard {...card} status="unknown" />);
    expect(screen.getByText("Sent. Waiting for it to be confirmed; it is checked again on its own, and nothing is paid twice.")).toBeTruthy();
    expect(screen.getByText("Not confirmed yet")).toBeTruthy();
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
    expect(screen.getByText("Approve this request?")).toBeTruthy();
  });

  it("never asks to approve $0.00", () => {
    render(<ProposalCard {...card} impact={{ cents: 0, direction: "out" }} confirmQuestion={undefined} />);
    expect(button("Approve $0.00")).toBeNull();
    fireEvent.click(button("Approve")!);
    expect(screen.getByText("Approve this request?")).toBeTruthy();
    expect(screen.queryByText("Approve $0.00?")).toBeNull();
  });

  it("keeps a given question even when no money moves", () => {
    render(
      <ProposalCard {...card} impact={{ cents: 0, direction: "none" }} confirmQuestion="Move it to INV-2?" initialConfirming />,
    );
    expect(screen.getByText("Move it to INV-2?")).toBeTruthy();
    expect(screen.queryByText("Approve this request?")).toBeNull();
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
        destination={{ label: "To fuel card ending 4417", testMode: true }}
        confirmQuestion="Pay $200.00 to Sample Driver's fuel card ending 4417?"
      />,
    );
    const line = screen.getByText("To fuel card ending 4417 · Test mode");
    // One small line that may wrap at phone width: nothing in it refuses to break.
    expect(line.closest("p")?.className).not.toContain("nowrap");
    expect(line.closest("p")?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(button("Approve $200.00")!);
    expect(screen.getByText("Pay $200.00 to Sample Driver's fuel card ending 4417?")).toBeTruthy();
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

describe("ProposalCard's confirm and reject questions", () => {
  const LONG_DRIVER = "11111111-1111-4111-8111-111111111111";
  const LONG_LOAD_A = "22222222-2222-4222-8222-222222222222";
  const LONG_LOAD_B = "33333333-3333-4333-8333-333333333333";

  it("sends exactly the card's id on Confirm, as before, and nothing on Approve or Keep reviewing", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ProposalCard {...card} confirmNoun="advance" onApprove={onApprove} onReject={onReject} />);
    fireEvent.click(button("Approve $200.00")!);
    fireEvent.click(button("Keep reviewing")!);
    fireEvent.click(button("Approve $200.00")!);
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(button("Confirm")!);
    // The card's whole output is this call; the chat builds the same request body from it.
    expect(onApprove.mock.calls).toEqual([["p-1"]]);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("writes the count, the total and what happens next under the question", () => {
    const { unmount } = render(
      <ProposalCard {...card} confirmNoun="advance" confirmNext="This is a test payout to the driver's fuel card." initialConfirming />,
    );
    const group = screen.getByRole("group", { name: "Confirm approval" });
    expect(group.textContent).toContain("Pay $200.00 to Sample Driver?");
    expect(group.textContent).toContain("1 advance, $200.00.");
    expect(group.textContent).toContain("This is a test payout to the driver's fuel card.");
    unmount();

    // Without the caller's words the card still says what it is and what happens.
    render(<ProposalCard {...card} confirmQuestion={undefined} initialConfirming />);
    const plain = screen.getByRole("group", { name: "Confirm approval" });
    expect(plain.textContent).toContain("Approve this request?");
    expect(plain.textContent).toContain("1 request, $200.00.");
    expect(plain.textContent).toContain(CONFIRM_NEXT);
  });

  it("asks once before Reject, says nothing is sent, and rejects only on the second Reject", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ProposalCard {...card} confirmNoun="advance" onApprove={onApprove} onReject={onReject} />);
    fireEvent.click(button("Reject")!);
    expect(onReject).not.toHaveBeenCalled();
    const group = screen.getByRole("group", { name: "Confirm rejection" });
    expect(group.textContent).toContain("Reject this advance?");
    expect(group.textContent).toContain(REJECT_NEXT);
    expect(document.activeElement).toBe(button("Keep it"));
    // Approve is not offered while the reject question is open.
    expect(button("Approve $200.00")).toBeNull();

    fireEvent.click(button("Keep it")!);
    expect(screen.queryByRole("group", { name: "Confirm rejection" })).toBeNull();
    expect(document.activeElement).toBe(button("Reject"));
    expect(onReject).not.toHaveBeenCalled();

    fireEvent.click(button("Reject")!);
    const confirmReject = screen.getByRole("group", { name: "Confirm rejection" }).querySelectorAll("button")[1];
    expect(confirmReject.textContent).toBe("Reject");
    fireEvent.click(confirmReject);
    expect(onReject.mock.calls).toEqual([["p-1"]]);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("disables both reject buttons while the rejection is in flight", () => {
    const { rerender } = render(<ProposalCard {...card} />);
    fireEvent.click(button("Reject")!);
    rerender(<ProposalCard {...card} pending />);
    expect((button("Keep it") as HTMLButtonElement).disabled).toBe(true);
    expect((button(/Rejecting/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before rejecting a blocked card too, and keeps the reason typed so far", () => {
    const onReject = vi.fn();
    render(<ProposalCard {...card} audit={{ state: "block" }} onReject={onReject} />);
    const box = () => screen.getByLabelText(/Why approve it anyway/) as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: "Driver showed the receipt" } });
    fireEvent.click(button("Reject")!);
    expect(screen.getByText("Reject this request?")).toBeTruthy();
    fireEvent.click(button("Keep it")!);
    expect(box().value).toBe("Driver showed the receipt");
    fireEvent.click(button("Reject")!);
    fireEvent.click(screen.getByRole("group", { name: "Confirm rejection" }).querySelectorAll("button")[1]);
    expect(onReject.mock.calls).toEqual([["p-1"]]);
  });

  it("names records the caller knows in Also read, and any other by its kind with no id tail", () => {
    render(
      <ProposalCard
        {...card}
        reasons={[{ text: "Earned and unpaid this week: $2,400.00", source: { table: "loads", id: LONG_LOAD_A } }]}
        sources={[
          { table: "drivers", id: LONG_DRIVER },
          { table: "loads", id: LONG_LOAD_B },
        ]}
        references={{ [`drivers:${LONG_DRIVER}`]: "Driver BR-D07" }}
      />,
    );
    expect(screen.getByRole("link", { name: "Driver BR-D07" }).getAttribute("href")).toBe(`/records/drivers/${LONG_DRIVER}`);
    // Two loads the caller did not name read by kind, numbered, never by a piece of their id.
    expect(screen.getByRole("link", { name: "Load 1 of 2" }).getAttribute("href")).toBe(`/records/loads/${LONG_LOAD_A}`);
    expect(screen.getByRole("link", { name: "Load 2 of 2" }).getAttribute("href")).toBe(`/records/loads/${LONG_LOAD_B}`);
    expect(document.body.textContent).not.toMatch(/2222|3333|1111/);
  });
});

describe("ProposalCard with the auditor's check", () => {
  it("shows a fixed badge per verdict, and the plain sentence for every verdict but pass", () => {
    const cases: [ProposalAudit["state"], string][] = [
      ["pass", "Second check passed"],
      ["concerns", "Second check has concerns"],
      ["block", "Second check did not pass"],
      ["unknown", "Second check could not run"],
      ["budget", "Second check skipped: demo budget reached"],
      ["off", "Second check is off"],
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
    expect(screen.getByText("The second check could not run on this request. Your data is unchanged.")).toBeTruthy();
    expect(button("Approve $200.00")).toBeTruthy();
  });

  it("says the second check is running, as a status", () => {
    render(<ProposalCard {...card} audit={{ state: "checking" }} />);
    expect(screen.getByRole("status").textContent).toContain("Running the second check...");
  });

  it("asks the given confirm question on concerns", () => {
    const onApprove = vi.fn();
    render(
      <ProposalCard
        {...card}
        audit={{ state: "concerns", text: "The amount does not match the records." }}
        confirmQuestion="The second check has concerns. Approve anyway?"
        onApprove={onApprove}
      />,
    );
    fireEvent.click(button("Approve $200.00")!);
    expect(screen.getByText("The second check has concerns. Approve anyway?")).toBeTruthy();
    fireEvent.click(button("Confirm")!);
    expect(onApprove).toHaveBeenCalledWith("p-1");
  });

  it("offers no plain Approve on a block, only a reason box, a counter and Approve anyway", () => {
    render(<ProposalCard {...card} audit={{ state: "block", text: "The amount does not match the records." }} />);
    expect(button("Approve $200.00")).toBeNull();
    expect(button("Reject")).toBeTruthy();
    const box = screen.getByLabelText("Why approve it anyway? (10 to 240 characters)");
    expect(screen.getByText("0 of 240")).toBeTruthy();
    const override = button("Approve anyway") as HTMLButtonElement;
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
    fireEvent.click(button("Approve anyway")!);
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByText("Approve even though the second check did not pass?")).toBeTruthy();
    expect(document.activeElement).toBe(button("Keep reviewing"));

    fireEvent.click(button("Keep reviewing")!);
    expect(button("Confirm")).toBeNull();
    expect(document.activeElement).toBe(button("Approve anyway"));

    fireEvent.click(button("Approve anyway")!);
    expect(screen.getByRole("group", { name: "Confirm approval" }).textContent).toContain("Your reason is saved with this approval.");
    fireEvent.click(button("Confirm")!);
    expect(onApprove.mock.calls).toEqual([["p-1", "Driver showed the receipt"]]);
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
    expect(screen.getByText("Second check did not pass")).toBeTruthy();
    expect(screen.getByText("Overridden by an admin on Oct 28, 2026, 3:00 PM UTC: Driver showed the receipt")).toBeTruthy();
    // The only button left is the help on the second check's words; no Approve, Reject or Confirm.
    expect(screen.queryAllByRole("button").map((b) => b.textContent)).toEqual(["Second check did not pass"]);
  });
});
