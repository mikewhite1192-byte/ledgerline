// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/app/toast";
import { EMAIL_UNCONFIRMED_WORDS, UNCONFIRMED_DECISION_WORDS } from "@/lib/collections/words";
import { CollectionsBoard, type BoardCard } from "./collections-board";

// A reminder card's two buttons with the server a stand-in: every answer that is not a success
// reads the page again so the card shows where the reminder stands, a server failure claims neither
// outcome, and an approval whose email may or may not have gone never says "Nothing was sent".

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

const CARD: BoardCard = {
  id: "5d6e7f80-9a1b-4c2d-8e3f-405162738495",
  status: "drafted",
  tone: "firm",
  customerName: "Test Customer",
  customerHref: null,
  invoiceNumber: "TST-INV-10002",
  invoiceHref: null,
  daysLate: 62,
  balanceText: "$800.00",
  dueText: "Sep 1, 2026",
  subject: "Invoice TST-INV-10002 is past due",
  body: "Hello,\n\nThe balance of $800.00 on invoice TST-INV-10002 is 62 days past due.",
  refusalCategory: null,
  afterText: null,
};

// Press a button with the server answering this status and body; return the toast's words.
async function press(button: "Approve reminder" | "Reject", status: number, json: unknown): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } })),
  );
  render(
    <ToastProvider>
      <CollectionsBoard toDraft={[]} cards={[CARD]} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: button }));
  const notes = screen.getByRole("status", { name: "Notifications" });
  await waitFor(() => expect(notes.textContent).not.toBe(""));
  return notes.textContent ?? "";
}

describe("a reminder card's decision", () => {
  it("reads the page again after a refusal, so a decided card does not keep its buttons", async () => {
    const words = await press("Approve reminder", 409, { error: "already_decided" });
    expect(words).toContain("Not approved");
    expect(words).toContain("Someone already decided this reminder.");
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
    refresh.mockReset();
    expect(await press("Reject", 404, { error: "not_found" })).toContain("Not rejected");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says neither approved nor not approved when the server failed, and reads the page again", async () => {
    for (const button of ["Approve reminder", "Reject"] as const) {
      const words = await press(button, 503, { error: "unavailable" });
      expect(words).toContain(UNCONFIRMED_DECISION_WORDS.title);
      expect(words).toContain(UNCONFIRMED_DECISION_WORDS.body);
      expect(words).not.toMatch(/Not approved|Not rejected/);
      expect(refresh).toHaveBeenCalledTimes(1);
      cleanup();
      refresh.mockReset();
    }
  });

  it("never says nothing was sent when the email may have gone out", async () => {
    const unknown = await press("Approve reminder", 200, {
      ok: true,
      status: "approved",
      channel: "email",
      email: "unknown",
      category: "unknown",
    });
    expect(unknown).toContain(EMAIL_UNCONFIRMED_WORDS);
    expect(unknown).not.toContain("Nothing was sent");
    cleanup();
    const off = await press("Approve reminder", 200, {
      ok: true,
      status: "approved",
      channel: "logged",
      email: "would_send",
      category: "disabled",
    });
    expect(off).toContain("Nothing was sent (Test mode).");
  });
});
