// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardStatus, ProposalView } from "@/lib/agent/view";
import type { SweepCounts } from "@/lib/sweep/run";
import type { SweepItemView, SweepPage } from "@/lib/sweep/view";
import { SweepRun } from "./sweep-run";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// One finished run with one drafted fix per card status. The driver code names the status, so each
// card's title says which one it is.
const STATUSES: CardStatus[] = ["proposed", "approved", "executing", "unknown", "rejected", "failed", "done", "expired"];

const counts: SweepCounts = {
  found: 8,
  fixes_drafted: 8,
  clean: 0,
  needs_person: 0,
  fixed_earlier: 0,
  declined_earlier: 0,
  expired_earlier: 0,
  refused: 0,
  blocked_live: 0,
  mismatch: 0,
  audit_pending: 0,
  over_cap: 0,
};

const proposal = (status: CardStatus, n: number): ProposalView => ({
  id: `p-${status}`,
  kind: "pay_correction",
  subjectTable: "drivers",
  subjectId: `00000000-0000-4000-8000-00000000000${n}`,
  subjectLabel: `D-${status}`,
  amountCents: 1_000 + n,
  direction: "out",
  title: "Pay correction",
  reasons: [],
  sources: [],
  status,
  flagged: false,
  flagCategories: [],
  operatorVerdict: "missing_reimbursement",
  auditorVerdict: "pass",
  auditorConcerns: [],
  auditorCheckedAt: "2026-11-02T16:00:00.000Z",
  auditorOverride: null,
  destination: null,
});

const item = (status: CardStatus, n: number): SweepItemView => ({
  id: `i-${status}`,
  check: "missing_reimbursement",
  category: "missing_reimbursement",
  leg: 1,
  kind: "fix",
  driverCode: `D-${status}`,
  driverName: null,
  expectedCents: 1_000 + n,
  note: null,
  sourceRefs: [],
  status: "drafted",
  refusalCategory: null,
  proposalId: `p-${status}`,
  proposalStatus: status,
  amountCents: 1_000 + n,
  direction: "out",
  auditorVerdict: "pass",
  decidedAt: null,
  clean: false,
  explanation: null,
  explainCategory: null,
  auditAttempts: 1,
});

const page: SweepPage = {
  run: {
    id: "11111111-1111-4111-8111-111111111111",
    periodId: "22222222-2222-4222-8222-222222222222",
    periodStart: "2026-10-26",
    periodEnd: "2026-11-01",
    trigger: "button",
    status: "done",
    phase: "done",
    capCents: 100,
    spentCents: 10,
    counts,
    truncatedReason: null,
    failureCategory: null,
    conversationId: null,
    startedAt: "2026-11-02T16:00:00.000Z",
    finishedAt: "2026-11-02T16:01:00.000Z",
    approved: 1,
  },
  items: STATUSES.map(item),
  counts,
  proposals: Object.fromEntries(STATUSES.map((s, n) => [`p-${s}`, proposal(s, n)])),
  clean: { proposalIds: [], totalCents: 0 },
};

// The cards in a folded section or a section, by their titles (a folded section's cards are in
// the page, only closed).
const titles = (el: HTMLElement) =>
  within(el)
    .queryAllByRole("article", { hidden: true })
    .map((a) => a.getAttribute("aria-label"));
const folded = (summary: RegExp) => screen.getByText(summary).closest("details") as HTMLElement;

describe("SweepRun", () => {
  it("lists only rejected and failed fixes as declined, and keeps approved, running and unknown ones under Needs a look", () => {
    render(<SweepRun initial={page} auditorOn />);
    expect(titles(folded(/^Declined \(/))).toEqual(["Pay correction for D-rejected", "Pay correction for D-failed"]);
    expect(screen.getByText("Declined (2)")).toBeTruthy();
    expect(titles(screen.getByRole("region", { name: "Needs a look" }))).toEqual([
      "Pay correction for D-proposed",
      "Pay correction for D-approved",
      "Pay correction for D-executing",
      "Pay correction for D-unknown",
    ]);
    expect(titles(folded(/^Fixed \(/))).toEqual(["Pay correction for D-done"]);
    expect(titles(folded(/^Expired undecided \(/))).toEqual(["Pay correction for D-expired"]);
    // Each card is listed once on the page.
    expect(screen.getAllByRole("article", { hidden: true })).toHaveLength(STATUSES.length);
  });
});

// The page's requests, answered from a table; a refresh reads the page back unchanged. An answer
// is a plain object (no body stream), or "lost" for a request that never comes back.
type Answer = { status: number; body: unknown } | "lost";
function serve(shown: SweepPage, answers: Record<"approve" | "reject" | "clean", Answer[]>) {
  const sent: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method) return { ok: true, status: 200, json: async () => shown } as unknown as Response;
    sent.push({ url, body: init.body ? JSON.parse(init.body) : null });
    const which = url.endsWith("/approve-clean") ? "clean" : url.endsWith("/approve") ? "approve" : "reject";
    const a = answers[which].shift() ?? "lost";
    if (a === "lost") throw new TypeError("Failed to fetch");
    return { ok: a.status < 400, status: a.status, json: async () => a.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return sent;
}

const cardOf = (driver: string) => screen.getByRole("article", { name: `Pay correction for ${driver}` });

// Approve, then Confirm (the confirm row stays open after an answer that changed nothing).
function approveCard(driver: string) {
  const approve = within(cardOf(driver)).queryByRole("button", { name: /^Approve \$/ });
  if (approve) fireEvent.click(approve);
  fireEvent.click(within(cardOf(driver)).getByRole("button", { name: "Confirm" }));
}
// The notice under a card (beside it, not inside it).
const noticeOf = (driver: string) =>
  cardOf(driver).parentElement?.querySelector(":scope > p[role=status]")?.textContent ?? null;
const settled = (driver: string, name: string) =>
  waitFor(() => expect(within(cardOf(driver)).getByRole("button", { name })).toHaveProperty("disabled", false));

describe("SweepRun answers", () => {
  it("says an approval's outcome is unknown when the answer is lost, and keeps a refusal definite", async () => {
    const sent = serve(page, {
      approve: [{ status: 503, body: { error: "unavailable" } }, "lost", { status: 409, body: { error: "not_executable" } }],
      reject: [],
      clean: [],
    });
    render(<SweepRun initial={page} auditorOn />);
    const unknown =
      "The answer did not come back, so this may or may not have been approved. Check the card's status before trying again.";
    const answers = [unknown, unknown, "Pay corrections are switched off, so this fix was not applied. Nothing changed."];
    for (const [n, expected] of answers.entries()) {
      approveCard("D-proposed");
      await waitFor(() => expect(sent).toHaveLength(n + 1));
      await settled("D-proposed", "Confirm");
      expect(noticeOf("D-proposed")).toBe(expected);
    }
  });

  it("says a rejection's outcome is unknown when the answer is lost, and keeps a refusal definite", async () => {
    const sent = serve(page, {
      approve: [],
      reject: ["lost", { status: 503, body: { error: "unavailable" } }, { status: 409, body: { error: "already_decided" } }],
      clean: [],
    });
    render(<SweepRun initial={page} auditorOn />);
    const unknown =
      "The answer did not come back, so this may or may not have been rejected. Check the card's status before trying again.";
    const answers = [unknown, unknown, "The rejection did not go through. Try again."];
    for (const [n, expected] of answers.entries()) {
      fireEvent.click(within(cardOf("D-proposed")).getByRole("button", { name: "Reject" }));
      await waitFor(() => expect(sent).toHaveLength(n + 1));
      await settled("D-proposed", "Reject");
      expect(noticeOf("D-proposed")).toBe(expected);
    }
  });

  it("offers Resume, never Approve or Reject, on an approved fix whose run stopped, and resumes the same approval", async () => {
    const sent = serve(page, { approve: [{ status: 200, body: { ok: true, status: "done" } }], reject: [], clean: [] });
    render(<SweepRun initial={page} auditorOn />);
    const card = cardOf("D-approved");
    expect(within(card).queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Reject" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe("/api/proposals/p-approved/approve");
  });
});

describe("SweepRun approve all", () => {
  const two = ["a", "b"].map((name, n) => ({
    ...item("proposed", n),
    id: `i-${name}`,
    driverCode: `D-${name}`,
    proposalId: `p-${name}`,
    clean: true,
  }));
  const cleanPage: SweepPage = {
    ...page,
    items: two,
    proposals: Object.fromEntries(
      two.map((i, n) => [i.proposalId, { ...proposal("proposed", n), id: i.proposalId, subjectLabel: i.driverCode }]),
    ),
    clean: { proposalIds: ["p-a", "p-b"], totalCents: 2_001 },
  };
  const confirmAll = () => {
    fireEvent.click(screen.getByRole("button", { name: /^Approve 2 clean fixes/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm approve all" })).getByRole("button", { name: "Confirm" }));
  };

  it("puts each refused fix's reason on its own card", async () => {
    serve(cleanPage, {
      approve: [],
      reject: [],
      clean: [{ status: 200, body: { ok: true, done: 0, refused: [
        { proposalId: "p-a", ok: false, category: "stale" },
        { proposalId: "p-b", ok: false, category: "approved" },
      ] } }],
    });
    render(<SweepRun initial={cleanPage} auditorOn />);
    confirmAll();
    expect(await screen.findByText("Approved 0. 2 did not go through; each card says why.")).toBeTruthy();
    expect(noticeOf("D-a")).toBe(
      "The records changed since this was drafted, so it was not applied. Reject it if it still waits, then run the sweep again.",
    );
    expect(noticeOf("D-b")).toBe(
      "The answer did not come back, so this may or may not have been approved. Check the card's status before trying again.",
    );
  });

  it("says the outcome is unknown when the server stops part way or the answer is lost, keeping the batch id", async () => {
    const sent = serve(cleanPage, {
      approve: [],
      reject: [],
      clean: [{ status: 503, body: { error: "unavailable" } }, "lost"],
    });
    render(<SweepRun initial={cleanPage} auditorOn />);
    const unknown =
      "The answer did not come back, so some fixes may have been approved. Check each card's status before trying again; a repeat of the same list never approves twice.";
    confirmAll();
    expect(await screen.findByText(unknown)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Approve 2 clean fixes/ })).toHaveProperty("disabled", false));
    confirmAll();
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(await screen.findByText(unknown)).toBeTruthy();
    expect(screen.queryByText(/Nothing was approved/)).toBeNull();
    const ids = sent.map((r) => (r.body as { batchId: string }).batchId);
    expect(ids[1]).toBe(ids[0]);
  });
});
