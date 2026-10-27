// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_PROPOSAL_ID, SAMPLE_TURN_ID, sampleTrace } from "@/lib/trace/sample";
import { HowWorkedOut, fetchTrace, type TraceLoad } from "./how-worked-out";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const ANSWER = "How this was worked out for this answer";
const CARD = "How this was worked out for this card";

function deferred() {
  let resolve!: (v: TraceLoad) => void;
  const promise = new Promise<TraceLoad>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("HowWorkedOut", () => {
  it("names the toggle under an answer apart from the one under a card", () => {
    render(
      <>
        <HowWorkedOut turnId={SAMPLE_TURN_ID} load={async () => ({ trace: sampleTrace() })} />
        <HowWorkedOut turnId={SAMPLE_TURN_ID} proposalId={SAMPLE_PROPOSAL_ID} load={async () => ({ trace: sampleTrace() })} />
      </>,
    );
    const [answer, card] = screen.getAllByRole("button", { name: /^How this was worked out/ });
    expect(answer.textContent).toBe(ANSWER);
    expect(card.textContent).toBe(CARD);
    expect(screen.getByRole("button", { name: ANSWER })).toBe(answer);
    expect(screen.getByRole("button", { name: CARD })).toBe(card);
    // The words that tell them apart are read aloud, not shown.
    expect(screen.getByText("for this answer").className).toContain("sr-only");
  });

  it("reads nothing until opened, then shows the loading state", async () => {
    const pending = deferred();
    const load = vi.fn(() => pending.promise);
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={load} />);
    const toggle = screen.getByRole("button", { name: ANSWER });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(load).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const status = await screen.findByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(load).toHaveBeenCalledWith(SAMPLE_TURN_ID);
    await act(async () => pending.resolve({ trace: sampleTrace() }));
  });

  it("lists each step with its model, effort, time and cost, and links its records", async () => {
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={async () => ({ trace: sampleTrace() })} />);
    fireEvent.click(screen.getByRole("button", { name: ANSWER }));
    const list = await screen.findByRole("list", { name: "Steps, in order" });
    expect(list.querySelectorAll(":scope > li")).toHaveLength(9);
    expect(screen.getAllByText("low effort, 1.8 s, 0.7 cents")).toHaveLength(1);
    expect(screen.getByText("Checking advance eligibility: blocked, the amount is over the eligible limit ($412.00)")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("5 model calls, 2.6 cents in all, 7.4 s of model time")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Pay item ending/ });
    expect(link.getAttribute("href")).toMatch(/^\/records\/pay_items\//);
  });

  it("shows the prompt cache line under a model call that has its counts", async () => {
    const trace = sampleTrace();
    const call = trace.steps[0].call!;
    trace.steps[0] = { ...trace.steps[0], call: { ...call, inputTokens: 2_480, cachedTokens: 1_912, savedNanocents: 1_912 * 110_000 } };
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={async () => ({ trace })} />);
    fireEvent.click(screen.getByRole("button", { name: ANSWER }));
    expect(await screen.findByText("1,912 of 2,480 input tokens from cache, saved 0.2 cents")).toBeTruthy();
    expect(screen.queryAllByText(/input tokens from cache/)).toHaveLength(1);
  });

  it("shows only the card's steps and the auditor's verdict under a card", async () => {
    render(
      <HowWorkedOut turnId={SAMPLE_TURN_ID} proposalId={SAMPLE_PROPOSAL_ID} load={async () => ({ trace: sampleTrace() })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: CARD }));
    await screen.findByRole("list", { name: "Steps, in order" });
    expect(screen.queryByText("Reading pay items: allowed")).toBeNull();
    expect(screen.getByText("Auditor (Muse Wonder)")).toBeTruthy();
    expect(screen.getByText("Checked the proposal and found no problem")).toBeTruthy();
    expect(screen.getByText("3 model calls, 7.3 cents in all, 8.1 s of model time")).toBeTruthy();
  });

  it("never shows a raw code", async () => {
    render(
      <HowWorkedOut turnId={SAMPLE_TURN_ID} proposalId={SAMPLE_PROPOSAL_ID} load={async () => ({ trace: sampleTrace() })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: CARD }));
    await screen.findByRole("list", { name: "Steps, in order" });
    const text = document.body.textContent ?? "";
    for (const code of ["propose_advance", "schema_failed_twice", "agent_operator_turn", "capped_to_eligible", "muse-wonder"]) {
      expect(text).not.toContain(code);
    }
  });

  it("shows the empty state when nothing was recorded", async () => {
    const trace = { ...sampleTrace(), steps: [], extraCalls: [], proposals: [] };
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={async () => ({ trace })} />);
    fireEvent.click(screen.getByRole("button", { name: ANSWER }));
    expect(await screen.findByText("Nothing on file for this yet")).toBeTruthy();
  });

  it("shows not found for a turn this person cannot see", async () => {
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={async () => ({ missing: true })} />);
    fireEvent.click(screen.getByRole("button", { name: ANSWER }));
    expect(await screen.findByText("That record is not here")).toBeTruthy();
  });

  it("shows the error with a retry that reads again", async () => {
    const load = vi
      .fn<(id: string) => Promise<TraceLoad>>()
      .mockResolvedValueOnce({ error: "unreadable" })
      .mockResolvedValueOnce({ trace: sampleTrace() });
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={load} />);
    fireEvent.click(screen.getByRole("button", { name: ANSWER }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not read your carrier's data");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("list", { name: "Steps, in order" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("treats a loader that throws as an error, not an empty trace", async () => {
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={() => Promise.reject(new Error("boom"))} />);
    fireEvent.click(screen.getByRole("button", { name: ANSWER }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Nothing on file for this yet")).toBeNull();
    expect(document.body.textContent).not.toContain("boom");
  });

  it("keeps the first read when closed and opened again", async () => {
    const load = vi.fn(async (): Promise<TraceLoad> => ({ trace: sampleTrace() }));
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={load} />);
    const toggle = screen.getByRole("button", { name: ANSWER });
    fireEvent.click(toggle);
    await screen.findByRole("list", { name: "Steps, in order" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await screen.findByRole("list", { name: "Steps, in order" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("opens from a link to its anchor, as an auditor footnote does", async () => {
    window.location.hash = `#trace-${SAMPLE_PROPOSAL_ID}`;
    const load = vi.fn(async (): Promise<TraceLoad> => ({ trace: sampleTrace() }));
    const { container } = render(
      <HowWorkedOut turnId={SAMPLE_TURN_ID} proposalId={SAMPLE_PROPOSAL_ID} load={load} />,
    );
    expect(container.querySelector(`#trace-${SAMPLE_PROPOSAL_ID}`)).toBeTruthy();
    await screen.findByRole("list", { name: "Steps, in order" });
    expect(screen.getByRole("button", { name: CARD }).getAttribute("aria-expanded")).toBe("true");
  });

  it("drops an answer that arrives after it is gone", async () => {
    const pending = deferred();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={() => pending.promise} />);
    fireEvent.click(screen.getByRole("button", { name: ANSWER }));
    unmount();
    await act(async () => pending.resolve({ trace: sampleTrace() }));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("fetchTrace", () => {
  it("reads the trace route and maps each outcome", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ trace: sampleTrace() }), { status: 200 }));
    const ok = await fetchTrace(SAMPLE_TURN_ID);
    expect("trace" in ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/agent/turns/${SAMPLE_TURN_ID}/trace`);

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    expect(await fetchTrace(SAMPLE_TURN_ID)).toEqual({ missing: true });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    expect(await fetchTrace(SAMPLE_TURN_ID)).toEqual({ error: "forbidden" });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    expect(await fetchTrace(SAMPLE_TURN_ID)).toEqual({ error: "unreadable" });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await fetchTrace(SAMPLE_TURN_ID)).toEqual({ error: "unreadable" });
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await fetchTrace(SAMPLE_TURN_ID)).toEqual({ error: "unreadable" });
  });
});
