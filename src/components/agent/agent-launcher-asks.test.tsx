// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLauncher } from "./agent-launcher";
import type { AgentPanelConfig } from "./agent-panel";
import type { LiveAsk } from "./asks";
import { greetingLine, YES_UNKNOWN } from "./words";

// The launcher's questions against a stubbed server: the badge and the bubble for the newest one,
// Yes through the approve route with the card's own body, Not now and Got it, Ask a question
// filling the card's box, the x kept in this browser (and harmless when storage throws), the
// polite announcement once per question, and the poll's schedule (paused while hidden, stopped
// for good by the switch off). The bubble never opens the card by itself.

const opened: string[] = [];
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  opened.length = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    opened.push("beside");
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    opened.push("modal");
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const items = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

const KEY = "asks:0123456789abcdef0123456789abcdef";

const CONFIG: AgentPanelConfig = {
  streamMode: "poll",
  auditorOn: false,
  stepThrough: false,
  timezone: "America/New_York",
  viewer: { admin: false, adminAboveCents: 50_000 },
  role: "staff",
  greeting: greetingLine("Test Carrier"),
  asksOn: true,
  asksKey: KEY,
};

const ADVANCE: LiveAsk = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  kind: "ask",
  proposalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  proposalKind: "advance_payout",
  text: "All paperwork is in for load BR-L10230. Should I send Wesley Delgado the 70% advance, $640.00?",
  reason: "Signed BOL came in at 6:10, rate con on file, no other advance on this load.",
  createdAt: "2026-11-02T15:10:00.000Z",
  shownAt: "2026-11-02T15:10:00.000Z",
};

const INVOICE: LiveAsk = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  kind: "ask",
  proposalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  proposalKind: "invoice_post",
  text: "Load BR-L10216 is ready to bill. Should I post the $3,346.00 invoice to Acme Foods?",
  reason: null,
  createdAt: "2026-11-02T15:00:00.000Z",
  shownAt: "2026-11-02T15:00:00.000Z",
};

const TOLD: LiveAsk = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  kind: "told",
  proposalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
  proposalKind: "advance_payout",
  text: "Sent Maria Ortega the 70% advance, $250.00, inside your $300.00 limit.",
  reason: null,
  createdAt: "2026-11-02T15:20:00.000Z",
  shownAt: "2026-11-02T15:20:00.000Z",
};

// A morning digest: no proposal, only Got it.
const DIGEST: LiveAsk = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
  kind: "digest",
  proposalId: null,
  proposalKind: null,
  text: "Morning digest. Needs you: 2 card breaks. Yesterday: 1 trip cancelled.",
  reason: null,
  createdAt: "2026-11-02T12:00:00.000Z",
  shownAt: "2026-11-02T12:00:00.000Z",
};

type Call = { url: string; init?: RequestInit };
// fail: the request itself throws, as a lost connection does.
type Reply = { status: number; body: unknown; fail?: boolean };

// The server: the asks read answers from `reads` in turn (the last one again after that), the
// approve and the two ask routes from `writes`, and the card's recent read is an empty thread.
function stubServer(opts: { reads: Reply[]; writes?: Record<string, Reply> }) {
  const calls: Call[] = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith("/api/agent/asks")) {
        const r = opts.reads[Math.min(n, opts.reads.length - 1)];
        n += 1;
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      if (url === "/api/agent/recent") {
        return new Response(JSON.stringify({ conversationId: null, turns: [], asks: [], thread: [] }), { status: 200 });
      }
      for (const [path, r] of Object.entries(opts.writes ?? {})) {
        if (!url.endsWith(path)) continue;
        if (r.fail) throw new TypeError("network");
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }),
  );
  return { calls, reads: () => calls.filter((c) => c.url.startsWith("/api/agent/asks")) };
}

const showing = (asks: LiveAsk[], openCount = asks.length): Reply => ({
  status: 200,
  body: { asks, openCount, now: "2026-11-02T16:00:00.000Z" },
});

function page(config: AgentPanelConfig = CONFIG) {
  return render(
    <AgentLauncher config={config} suggestions={[]}>
      <main>Customers</main>
    </AgentLauncher>,
  );
}

const bubble = () => screen.getByRole("region", { name: "The agent's questions" });
const findBubble = () => screen.findByRole("region", { name: "The agent's questions" });

describe("the agent's questions on the launcher", () => {
  it("shows the count and the newest question with its reason and buttons, and never opens the card", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    stubServer({ reads: [showing([INVOICE, ADVANCE])] });
    page();
    const b = await findBubble();
    expect(within(b).getByText(ADVANCE.text)).toBeTruthy();
    expect(within(b).getByText(ADVANCE.reason ?? "")).toBeTruthy();
    for (const name of ["Yes", "Not now", "Ask a question", "Close this question"]) {
      expect(within(b).getByRole("button", { name })).toBeTruthy();
    }
    expect(within(b).getByText("1 more waiting")).toBeTruthy();
    expect(screen.getByTestId("ask-badge").textContent).toBe("2");
    expect(screen.getByRole("button", { name: "Ask the agent, 2 waiting" })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("ask-announcer").textContent).toBe("New question from the agent"));
    expect(opened).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("approves on Yes with the card's own body and shows the code's line", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const server = stubServer({
      reads: [showing([ADVANCE])],
      writes: { [`/api/proposals/${ADVANCE.proposalId}/approve`]: { status: 200, body: { ok: true, status: "done" } } },
    });
    page();
    fireEvent.click(within(await findBubble()).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(within(bubble()).getByRole("status").textContent).toBe("Sent. The advance is on its way."));
    const post = server.calls.find((c) => c.url.endsWith("/approve"));
    expect(post?.url).toBe(`/api/proposals/${ADVANCE.proposalId}/approve`);
    expect(post?.init?.method).toBe("POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ confirmed: false });
    expect(within(bubble()).queryByRole("button", { name: "Yes" })).toBeNull();
    expect(screen.queryByTestId("ask-badge")).toBeNull();
  });

  it("shows a fixed line, never the server's text, when Yes does not go through", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    stubServer({
      reads: [showing([ADVANCE])],
      writes: {
        [`/api/proposals/${ADVANCE.proposalId}/approve`]: {
          status: 409,
          body: { error: "needs_confirm", detail: "raw text from db-host" },
        },
      },
    });
    page();
    fireEvent.click(within(await findBubble()).getByRole("button", { name: "Yes" }));
    await within(bubble()).findByText("This one needs a closer look first. Open it from Needs you on Home.");
    expect(bubble().textContent).not.toContain("db-host");
    expect(within(bubble()).getByRole("button", { name: "Yes" })).toBeTruthy();
  });

  it("puts it off on Not now and shows the next one", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const server = stubServer({
      reads: [showing([ADVANCE, INVOICE])],
      writes: { [`/api/asks/${ADVANCE.id}/snooze`]: { status: 200, body: { ok: true, snoozedUntil: "2026-11-03T14:00:00.000Z" } } },
    });
    page();
    fireEvent.click(within(await findBubble()).getByRole("button", { name: "Not now" }));
    await within(bubble()).findByText(INVOICE.text);
    expect(server.calls.find((c) => c.url.endsWith("/snooze"))?.init?.method).toBe("POST");
    expect(screen.getByTestId("ask-badge").textContent).toBe("1");
  });

  it("marks a told line seen on Got it", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const server = stubServer({
      reads: [showing([TOLD])],
      writes: { [`/api/asks/${TOLD.id}/ack`]: { status: 200, body: { ok: true } } },
    });
    page();
    const b = await findBubble();
    expect(within(b).queryByRole("button", { name: "Yes" })).toBeNull();
    await waitFor(() => expect(screen.getByTestId("ask-announcer").textContent).toBe("New note from the agent"));
    fireEvent.click(within(b).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "The agent's questions" })).toBeNull());
    expect(server.calls.find((c) => c.url.endsWith("/ack"))?.url).toBe(`/api/asks/${TOLD.id}/ack`);
  });

  it("shows a morning digest with only Got it, and marks it seen", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const server = stubServer({
      reads: [showing([DIGEST])],
      writes: { [`/api/asks/${DIGEST.id}/ack`]: { status: 200, body: { ok: true } } },
    });
    page();
    const b = await findBubble();
    expect(within(b).getByText(DIGEST.text)).toBeTruthy();
    expect(within(b).queryByRole("button", { name: "Yes" })).toBeNull();
    expect(within(b).queryByRole("button", { name: "Not now" })).toBeNull();
    await waitFor(() => expect(screen.getByTestId("ask-announcer").textContent).toBe("New note from the agent"));
    fireEvent.click(within(b).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "The agent's questions" })).toBeNull());
    expect(server.calls.find((c) => c.url.endsWith("/ack"))?.url).toBe(`/api/asks/${DIGEST.id}/ack`);
    expect(server.calls.some((c) => c.url.includes("/api/proposals/"))).toBe(false);
  });

  it("opens the card on Ask a question with the load in the box, unsent", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    const server = stubServer({ reads: [showing([ADVANCE])] });
    page();
    fireEvent.click(within(await findBubble()).getByRole("button", { name: "Ask a question" }));
    const dialog = screen.getByRole("dialog", { name: "Agent" });
    const box = (await within(dialog).findByRole("textbox", { name: "Your question" })) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("About load BR-L10230: "));
    expect(server.calls.some((c) => c.url === "/api/agent/turn")).toBe(false);
    // While the card is open the bubble steps aside; the card's thread shows the question.
    expect(screen.queryByRole("region", { name: "The agent's questions" })).toBeNull();
    await within(dialog).findByText(ADVANCE.text);
  });

  it("keeps a closed question closed in this browser, and closes it even when storage throws", async () => {
    const store = memoryStorage();
    vi.stubGlobal("localStorage", store);
    stubServer({ reads: [showing([ADVANCE])] });
    const first = page();
    fireEvent.click(within(await findBubble()).getByRole("button", { name: "Close this question" }));
    expect(screen.queryByRole("region", { name: "The agent's questions" })).toBeNull();
    expect(JSON.parse(store.getItem(KEY) ?? "[]")).toEqual([ADVANCE.id]);
    // The badge still counts it: it is open, only out of the bubble.
    expect(screen.getByTestId("ask-badge").textContent).toBe("1");
    first.unmount();
    page();
    await waitFor(() => expect(screen.getByTestId("ask-badge").textContent).toBe("1"));
    expect(screen.queryByRole("region", { name: "The agent's questions" })).toBeNull();
    cleanup();

    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    vi.stubGlobal("localStorage", blocked);
    page();
    fireEvent.click(within(await findBubble()).getByRole("button", { name: "Close this question" }));
    expect(screen.queryByRole("region", { name: "The agent's questions" })).toBeNull();
  });

  it("says the outcome is unknown, never that nothing changed, when the reply is lost or a server error", async () => {
    const approve = `/api/proposals/${ADVANCE.proposalId}/approve`;
    const cases: Array<[string, Reply]> = [
      ["the request throws", { status: 0, body: {}, fail: true }],
      ["a 503 unavailable", { status: 503, body: { error: "unavailable" } }],
    ];
    for (const [, reply] of cases) {
      vi.stubGlobal("localStorage", memoryStorage());
      stubServer({ reads: [showing([ADVANCE])], writes: { [approve]: reply } });
      page();
      fireEvent.click(within(await findBubble()).getByRole("button", { name: "Yes" }));
      await within(bubble()).findByText(YES_UNKNOWN);
      expect(bubble().textContent).not.toContain("Nothing changed");
      cleanup();
    }
  });

  it("keeps the known words for a refusal with a category", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    stubServer({
      reads: [showing([ADVANCE])],
      writes: { [`/api/proposals/${ADVANCE.proposalId}/approve`]: { status: 409, body: { error: "stale" } } },
    });
    page();
    fireEvent.click(within(await findBubble()).getByRole("button", { name: "Yes" }));
    await within(bubble()).findByText("Something changed since this showed. Check Needs you before trying again.");
    expect(screen.queryByText(YES_UNKNOWN)).toBeNull();
  });

  it.each([
    ["already_decided", "This was already decided."],
    ["expired", "This expired. Nothing changed."],
    ["not_found", "This is no longer waiting."],
  ])("lets the question go when Yes finds it %s somewhere else", async (category, line) => {
    vi.stubGlobal("localStorage", memoryStorage());
    stubServer({
      reads: [showing([ADVANCE])],
      writes: { [`/api/proposals/${ADVANCE.proposalId}/approve`]: { status: category === "not_found" ? 404 : 409, body: { error: category } } },
    });
    page();
    fireEvent.click(within(await findBubble()).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(within(bubble()).getByRole("status").textContent).toBe(line));
    expect(within(bubble()).queryByRole("button", { name: "Yes" })).toBeNull();
    expect(screen.queryByTestId("ask-badge")).toBeNull();
  });

  it("counts only the questions that can still show in the bubble, not the ones closed here", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    stubServer({ reads: [showing([ADVANCE, INVOICE, TOLD])] });
    page();
    expect(within(await findBubble()).getByText("2 more waiting")).toBeTruthy();
    expect(screen.getByTestId("ask-badge").textContent).toBe("3");
    fireEvent.click(within(bubble()).getByRole("button", { name: "Close this question" }));
    expect(within(bubble()).getByText("1 more waiting")).toBeTruthy();
    fireEvent.click(within(bubble()).getByRole("button", { name: "Close this question" }));
    expect(within(bubble()).queryByText(/more waiting/)).toBeNull();
    // The badge still counts all three: they are open, only out of the bubble.
    expect(screen.getByTestId("ask-badge").textContent).toBe("3");
  });

  it("announces a second new question even while the first one's line is still held", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    stubServer({
      reads: [showing([ADVANCE, INVOICE])],
      writes: { [`/api/asks/${ADVANCE.id}/snooze`]: { status: 200, body: { ok: true } } },
    });
    page();
    const announcer = screen.getByTestId("ask-announcer");
    const seen: string[] = [];
    const watch = new MutationObserver(() => seen.push(announcer.textContent ?? ""));
    watch.observe(announcer, { childList: true, characterData: true, subtree: true });
    await waitFor(() => expect(seen).toEqual(["New question from the agent"]));
    fireEvent.click(within(await findBubble()).getByRole("button", { name: "Not now" }));
    await within(bubble()).findByText(INVOICE.text);
    await waitFor(() => expect(seen).toEqual(["New question from the agent", "", "New question from the agent"]));
    watch.disconnect();
  });

  it("puts the cursor back on the launcher button when Got it, Not now or the x removes the bubble", async () => {
    const launcher = () => screen.getByRole("button", { name: /^Ask the agent/ });
    vi.stubGlobal("localStorage", memoryStorage());
    stubServer({
      reads: [showing([TOLD])],
      writes: { [`/api/asks/${TOLD.id}/ack`]: { status: 200, body: { ok: true } } },
    });
    page();
    const got = within(await findBubble()).getByRole("button", { name: "Got it" });
    got.focus();
    fireEvent.click(got);
    await waitFor(() => expect(screen.queryByRole("region", { name: "The agent's questions" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(launcher()));
    cleanup();

    vi.stubGlobal("localStorage", memoryStorage());
    stubServer({
      reads: [showing([ADVANCE])],
      writes: { [`/api/asks/${ADVANCE.id}/snooze`]: { status: 200, body: { ok: true } } },
    });
    page();
    const notNow = within(await findBubble()).getByRole("button", { name: "Not now" });
    notNow.focus();
    fireEvent.click(notNow);
    await waitFor(() => expect(screen.queryByRole("region", { name: "The agent's questions" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(launcher()));
    cleanup();

    vi.stubGlobal("localStorage", memoryStorage());
    stubServer({ reads: [showing([ADVANCE])] });
    page();
    const x = within(await findBubble()).getByRole("button", { name: "Close this question" });
    x.focus();
    fireEvent.click(x);
    await waitFor(() => expect(document.activeElement).toBe(launcher()));
  });

  it("asks nothing while the questions are off", async () => {
    const server = stubServer({ reads: [showing([ADVANCE])] });
    page({ ...CONFIG, asksOn: false });
    await act(async () => {});
    expect(server.calls).toEqual([]);
    expect(screen.queryByTestId("ask-badge")).toBeNull();
  });
});

describe("the launcher's poll", () => {
  const flush = () => act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const wait = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

  it("asks again every 30 seconds from the server's clock, waits while hidden, and looks at once when shown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", memoryStorage());
    const server = stubServer({ reads: [showing([ADVANCE]), showing([], 1)] });
    page();
    await flush();
    expect(server.reads().map((c) => c.url)).toEqual(["/api/agent/asks"]);
    await wait(29_999);
    expect(server.reads()).toHaveLength(1);
    await wait(1);
    expect(server.reads()).toHaveLength(2);
    // From a few minutes before the server's last clock, so a question committed late is not missed.
    expect(server.reads()[1].url).toBe(`/api/agent/asks?since=${encodeURIComponent("2026-11-02T15:55:00.000Z")}`);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(10 * 60_000);
    expect(server.reads()).toHaveLength(2);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(server.reads()).toHaveLength(3);
  });

  it("stretches to 120 seconds after 10 empty replies", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", memoryStorage());
    const server = stubServer({ reads: [showing([], 0)] });
    page();
    await flush();
    for (let i = 0; i < 9; i += 1) await wait(30_000);
    expect(server.reads()).toHaveLength(10);
    await wait(30_000);
    expect(server.reads()).toHaveLength(10);
    await wait(90_000);
    expect(server.reads()).toHaveLength(11);
  });

  it("stops quietly for good when the switch is off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", memoryStorage());
    const server = stubServer({ reads: [{ status: 409, body: { error: "asks_off" } }] });
    page();
    await flush();
    await wait(60 * 60_000);
    expect(server.reads()).toHaveLength(1);
    expect(screen.queryByTestId("ask-badge")).toBeNull();
    expect(screen.queryByRole("region", { name: "The agent's questions" })).toBeNull();
  });

  it.each([401, 409])("stays stopped after a %i when the tab is hidden and shown again", async (status) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("localStorage", memoryStorage());
    const server = stubServer({ reads: [{ status, body: { error: "stopped" } }] });
    page();
    await flush();
    expect(server.reads()).toHaveLength(1);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await wait(60_000);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    await wait(60 * 60_000);
    expect(server.reads()).toHaveLength(1);
  });
});
