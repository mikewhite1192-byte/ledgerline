// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CardStatus, ProposalView } from "@/lib/agent/view";
import type { SweepCounts } from "@/lib/sweep/run";
import type { SweepItemView, SweepPage } from "@/lib/sweep/view";
import { SweepRun } from "./sweep-run";

afterEach(cleanup);

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
