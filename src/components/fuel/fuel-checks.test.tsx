// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalView } from "@/lib/agent/view";
import type { FuelPage, FuelRowView } from "@/lib/fuel/view";
import { FuelChecks } from "./fuel-checks";

// The fuel page's working part with the server a stand-in: the main button checks and reads the
// page back, a row opens its detail, the two actions post to their routes, and a lost answer says
// the outcome is not known. No internal word or raw id reaches the screen.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const OPEN_ID = "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e";
const DUP_ID = "7c2d0e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f";
const SENT_ID = "8d3e1f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";
const CARD_ID = "9e4f2a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b";

function row(over: Partial<FuelRowView>): FuelRowView {
  return {
    id: OPEN_ID,
    check: "fuel_off_route",
    status: "open",
    driverName: "Dana Whitfield",
    truckUnit: "412",
    purchasedOn: "2026-10-29",
    amountCents: 36_575,
    gallonsMilli: 95_000,
    tankGallons: 200,
    excessCents: null,
    suggestedCents: -36_575,
    noSuggestion: null,
    dismissCategory: null,
    purchaseRef: "br-fuel-311",
    otherPurchaseRef: null,
    loadId: "5a0b8c1d-2e3f-4a4b-8c5d-6e7f8a9b0c1d",
    loadNumber: "BR-L10311",
    payItemRef: null,
    compare: { verdict: null, confidence: null, category: null },
    photoIds: [],
    sentence: "Dana Whitfield bought 95.0 gallons in Tennessee on Oct 29, but load BR-L10311 ran through Georgia.",
    proposal: null,
    ...over,
  };
}

const card: ProposalView = {
  id: CARD_ID,
  kind: "pay_correction",
  subjectTable: "drivers",
  subjectId: "00000000-0000-4000-8000-000000000001",
  subjectLabel: "Sam Ortiz",
  amountCents: -12_000,
  direction: "in",
  title: "Pay correction",
  reasons: [],
  sources: [],
  status: "proposed",
  flagged: false,
  flagCategories: [],
  operatorVerdict: null,
  auditorVerdict: "pass",
  auditorConcerns: [],
  auditorCheckedAt: "2026-11-02T16:00:00.000Z",
  auditorOverride: null,
  destination: null,
} as unknown as ProposalView;

function page(rows: FuelRowView[], lastRun: FuelPage["lastRun"] = {
  status: "done",
  checked: 464,
  found: 4,
  startedAt: "2026-11-02T16:00:00.000Z",
  finishedAt: "2026-11-02T16:00:04.000Z",
}): FuelPage {
  return { lastRun, needYou: rows.filter((r) => r.status === "open").length, rows };
}

const ROWS = [
  row({}),
  row({
    id: DUP_ID,
    check: "fuel_duplicate",
    driverName: "Lee Park",
    suggestedCents: null,
    noSuggestion: "card_double_charge",
    otherPurchaseRef: "br-fuel-312",
    photoIds: ["doc-a", "doc-b"],
    compare: { verdict: "same", confidence: "high", category: null },
    sentence: "Lee Park turned in the same fill-up twice on Oct 29.",
  }),
  row({ id: SENT_ID, status: "proposed", driverName: "Sam Ortiz", proposal: card }),
];

function reply(status: number, body: unknown) {
  return new Response(new Uint8Array(Buffer.from(JSON.stringify(body))), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => reply(200, { ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

const show = (p: FuelPage) => render(<FuelChecks page={p} auditorOn={false} timezone="America/Chicago" />);
const urls = () => fetchMock.mock.calls.map(([url]) => String(url));
const bodyOf = (i: number) => JSON.parse(String((fetchMock.mock.calls[i][1] as RequestInit).body)) as unknown;

describe("FuelChecks", () => {
  it("shows the last check's line and one row per problem, with plain labels and status words", () => {
    show(page(ROWS));
    expect(screen.getByText("Checked 464 fill-ups, 2 need you.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check this week's fuel" })).toBeTruthy();
    expect(screen.getAllByText("Fuel bought off the route")[0].getAttribute("title")).toBe(
      "The state on the receipt is not one this load drove through",
    );
    expect(screen.getAllByText("Needs you")).toHaveLength(2);
    expect(screen.getByText("Sent for approval")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/proposal|tenant|ledger|executor|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it("checks the fill-ups and reads the page back; a busy check says so", async () => {
    show(page(ROWS));
    fireEvent.click(screen.getByRole("button", { name: "Check this week's fuel" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(urls()).toEqual(["/api/fuel/runs"]);
    fetchMock.mockResolvedValueOnce(reply(409, { error: "busy", retryable: true }));
    fireEvent.click(screen.getByRole("button", { name: "Check this week's fuel" }));
    expect(await screen.findByText("A check is already running. Wait a moment, then look again.")).toBeTruthy();
  });

  it("lets a person check while the last run still reads running: the server answers busy, or gives up a stale run", async () => {
    // Started long ago and never finished: its request died, and only a new check clears it.
    show(page(ROWS, { status: "running", checked: 0, found: 0, startedAt: "2026-11-02T16:00:00.000Z", finishedAt: null }));
    expect(screen.getByText("Checking fill-ups...")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Check this week's fuel" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(urls()).toEqual(["/api/fuel/runs"]);
  });

  it("says the outcome is not known when the answer is lost", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network"));
    show(page(ROWS));
    fireEvent.click(screen.getByRole("button", { name: "Check this week's fuel" }));
    expect(
      await screen.findByText("The answer did not come back. Refresh the page to see where it stands before trying again."),
    ).toBeTruthy();
  });

  it("opens a row and proposes its correction, then reads the page back", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { proposalId: CARD_ID, existing: false }));
    show(page(ROWS));
    fireEvent.click(screen.getAllByRole("button", { name: /^See details: Fuel bought off the route/ })[0]);
    expect(screen.getByText(/but load BR-L10311 ran through Georgia/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "BR-L10311" }).getAttribute("href")).toBe(
      "/records/loads/5a0b8c1d-2e3f-4a4b-8c5d-6e7f8a9b0c1d",
    );
    fireEvent.click(screen.getByRole("button", { name: "Propose a pay correction of $365.75" }));
    expect(await screen.findByText("Sent for approval. Approve or reject it below.")).toBeTruthy();
    expect(urls()).toEqual([`/api/fuel/findings/${OPEN_ID}/propose`]);
    expect(refresh).toHaveBeenCalled();
  });

  it("names why a correction was refused", async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { error: "live_exists", retryable: false }));
    show(page(ROWS));
    fireEvent.click(screen.getAllByRole("button", { name: /^See details: Fuel bought off the route/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Propose a pay correction of $365.75" }));
    expect(await screen.findByText("A correction for this driver is already waiting. Decide that one first.")).toBeTruthy();
  });

  it("shows a duplicate's two photos and the compare line, with no correction offered and the reason why", () => {
    show(page(ROWS));
    fireEvent.click(screen.getByRole("button", { name: /^See details: Same receipt turned in twice/ }));
    const photos = screen.getAllByRole("img");
    expect(photos.map((p) => p.getAttribute("src"))).toEqual(["/api/documents/doc-a/file", "/api/documents/doc-b/file"]);
    // Each photo's box is held at the receipt's 3:4 before it loads, so the actions below never move.
    for (const p of photos) {
      expect(p.getAttribute("alt")).toMatch(/^Receipt photo [12]$/);
      expect(p.className.split(" ")).toEqual(expect.arrayContaining(["aspect-[3/4]", "w-full", "object-contain"]));
    }
    expect(screen.getByText("The two photos show the same receipt (high confidence).")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Propose a pay correction/ })).toBeNull();
    expect(
      screen.getByText("No pay change suggested: the card was charged twice, and the card company reverses that"),
    ).toBeTruthy();
  });

  it("dismisses with a reason from the list", async () => {
    show(page(ROWS));
    fireEvent.click(screen.getAllByRole("button", { name: /^See details: Fuel bought off the route/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss: it checks out" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Why it checks out" }), { target: { value: "pump_error" } });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(urls()).toEqual([`/api/fuel/findings/${OPEN_ID}/dismiss`]);
    expect(bodyOf(0)).toEqual({ category: "pump_error" });
  });

  it("shows a sent row's card and approves it on the card", async () => {
    show(page(ROWS));
    fireEvent.click(screen.getByRole("button", { name: /^See details: Fuel bought off the route, Sam Ortiz/ }));
    expect(screen.queryByRole("button", { name: /Propose a pay correction/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Approve/ }));
    const confirm = screen.queryByRole("button", { name: /^Confirm/ });
    if (confirm) fireEvent.click(confirm);
    await waitFor(() => expect(urls()).toEqual([`/api/proposals/${CARD_ID}/approve`]));
  });

  it("reads a sent row's status from its card: a carried-out correction says Corrected", () => {
    const done = { ...card, status: "done" } as ProposalView;
    show(page([row({ id: SENT_ID, status: "proposed", driverName: "Sam Ortiz", proposal: done })]));
    expect(screen.getByText("Corrected")).toBeTruthy();
    expect(screen.queryByText("Sent for approval")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^See details: Fuel bought off the route, Sam Ortiz/ }));
    expect(screen.getAllByText("Corrected")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Propose a pay correction/ })).toBeNull();
    cleanup();
    // A card still waiting keeps the row at Sent for approval.
    show(page(ROWS));
    expect(screen.queryByText("Corrected")).toBeNull();
    expect(screen.getByText("Sent for approval")).toBeTruthy();
  });

  it("says what to do when nothing was found, and when no check has run", () => {
    show(page([]));
    expect(screen.getByText("No fuel problems found this week.")).toBeTruthy();
    cleanup();
    show(page([], null));
    expect(screen.getAllByText("No fuel check yet").length).toBeGreaterThan(0);
    expect(screen.getByText("Click Check this week's fuel to look over this week's fill-ups.")).toBeTruthy();
  });
});
