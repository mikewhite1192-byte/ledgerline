// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnView } from "@/lib/agent/view";
import { AgentLauncher } from "./agent-launcher";
import type { AgentPanelConfig } from "./agent-panel";
import type { PageFocus } from "./page-focus";

// jsdom has no dialog methods, so these stand in for the browser's: opening sets the attribute,
// closing an open dialog clears it and fires the close event. `opened` records which kind opened.
const opened: string[] = [];
beforeEach(() => {
  opened.length = 0;
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
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  delete document.documentElement.dataset.agentPanel;
});

// A storage of the test's own, so nothing is left in the real one.
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

const CONFIG: AgentPanelConfig = {
  streamMode: "poll",
  auditorOn: false,
  stepThrough: false,
  timezone: "America/Chicago",
  viewer: { admin: false, adminAboveCents: 50_000 },
  role: "staff",
};

const DRIVER_ID = "11111111-1111-4111-8111-111111111111";
const FOCUS: PageFocus = { table: "drivers", id: DRIVER_ID, label: "Dana Reyes" };

const EARLIER: TurnView = {
  id: "t-1",
  conversationId: "c-1",
  seq: 1,
  userText: "How much is Dana owed this week?",
  status: "done",
  endedReason: null,
  text: "She is owed her base pay.",
  steps: [],
  proposals: [],
  flags: [],
  reports: [],
  error: null,
};

type Posted = Record<string, unknown>;

// The server: the recent read answers with `recent`, a question is taken, and its turn reads back
// finished, so the chat stops reading.
function stubServer(recent: { status: number; body: unknown }) {
  const posted: Posted[] = [];
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push(url);
      if (url === "/api/agent/recent") return new Response(JSON.stringify(recent.body), { status: recent.status });
      if (url === "/api/agent/turn") {
        posted.push(JSON.parse(String(init?.body)) as Posted);
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      const id = decodeURIComponent(url.split("/").at(-1) ?? "");
      const back: TurnView = { ...EARLIER, id, conversationId: "c-2", text: "Done." };
      return new Response(JSON.stringify({ turn: back }), { status: 200 });
    }),
  );
  return { posted, asked };
}

const EMPTY_RECENT = { status: 200, body: { conversationId: null, turns: [] } };

function page(focus?: PageFocus) {
  return render(
    <AgentLauncher config={CONFIG} focus={focus}>
      <main>
        <label>
          Search drivers
          <input />
        </label>
      </main>
    </AgentLauncher>,
  );
}

const launcher = () => screen.getByRole("button", { name: "Ask the agent" });
const panel = () => screen.getByRole("dialog", { name: "Agent" }) as HTMLDialogElement;
const questionBox = () => within(panel()).findByRole("textbox", { name: "Your question" });

async function ask(text: string) {
  fireEvent.change(await questionBox(), { target: { value: text } });
  fireEvent.click(within(panel()).getByRole("button", { name: "Send" }));
}

describe("the agent launcher", () => {
  it("opens the panel beside the page and closes it again, the cursor back on the button", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    stubServer(EMPTY_RECENT);
    page();
    expect(launcher().getAttribute("aria-haspopup")).toBe("dialog");
    expect(launcher().getAttribute("aria-expanded")).toBe("false");
    // Closed and never opened: no dialog, no question box, no request.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Your question" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(launcher());
    expect(panel().open).toBe(true);
    expect(opened).toEqual(["beside"]);
    expect(launcher().getAttribute("aria-expanded")).toBe("true");
    expect(document.documentElement.dataset.agentPanel).toBe("open");
    await waitFor(async () => expect(document.activeElement).toBe(await questionBox()));

    fireEvent.click(screen.getByRole("button", { name: "Close the agent" }));
    expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();
    expect(launcher().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(launcher());
    expect(document.documentElement.dataset.agentPanel).toBeUndefined();
    // Closed, it adds nothing a person can see or a screen reader can reach.
    expect(screen.queryByRole("textbox", { name: "Your question" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Conversation" })).toBeNull();
  });

  it("closes on Esc and puts the cursor back on the button", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    stubServer(EMPTY_RECENT);
    page();
    fireEvent.click(launcher());
    const box = await questionBox();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();
    expect(document.activeElement).toBe(launcher());
  });

  it("opens as the modal sheet on a phone", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }) as MediaQueryList);
    stubServer(EMPTY_RECENT);
    page();
    fireEvent.click(launcher());
    expect(opened).toEqual(["modal"]);
    expect(document.documentElement.dataset.agentPanel).toBeUndefined();
    await questionBox();
  });

  it("opens on / and puts the cursor in the question box, but never while typing or with a command key", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    stubServer(EMPTY_RECENT);
    page();
    const search = screen.getByRole("textbox", { name: "Search drivers" });
    fireEvent.keyDown(search, { key: "/" });
    fireEvent.keyDown(document.body, { key: "/", metaKey: true });
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "/", altKey: true });
    expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.append(editable);
    try {
      fireEvent.keyDown(editable, { key: "/" });
      expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();
    } finally {
      editable.remove();
    }

    fireEvent.keyDown(document.body, { key: "/" });
    expect(panel().open).toBe(true);
    await waitFor(async () => expect(document.activeElement).toBe(await questionBox()));
    // A slash typed into the question box is text, and the panel stays as it is.
    fireEvent.keyDown(await questionBox(), { key: "/" });
    expect(opened).toEqual(["beside"]);
  });

  it("asks about the page's record while the chip is on, and about nothing once it is dropped", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const { posted } = stubServer(EMPTY_RECENT);
    page(FOCUS);
    fireEvent.click(launcher());
    expect(await within(panel()).findByText("About: Dana Reyes")).toBeTruthy();

    await ask("Why is her pay lower this week?");
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].focus).toEqual({ table: "drivers", id: DRIVER_ID });
    expect(JSON.stringify(posted[0])).not.toContain("Dana Reyes");
    await within(panel()).findByText("Done.");

    fireEvent.click(within(panel()).getByRole("button", { name: "Stop asking about Dana Reyes" }));
    expect(within(panel()).queryByText("About: Dana Reyes")).toBeNull();
    await ask("And the fleet?");
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).not.toHaveProperty("focus");
    expect(posted[1]).toMatchObject({ conversationId: "c-2", text: "And the fleet?" });
  });

  it("starts empty, never on an error, when the recent read is refused", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const { asked } = stubServer({ status: 409, body: { error: "agent_off" } });
    page();
    fireEvent.click(launcher());
    await questionBox();
    expect(asked).toEqual(["/api/agent/recent"]);
    expect(within(panel()).queryByRole("alert")).toBeNull();
    expect(within(panel()).queryByRole("list", { name: "Conversation" })).toBeNull();
    expect(within(panel()).getByRole("heading", { name: "What do you want to know?" })).toBeTruthy();
  });

  it("picks up the newest conversation, keeps it for the next page, and starts over on New conversation", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    const { posted, asked } = stubServer({ status: 200, body: { conversationId: "c-1", turns: [EARLIER] } });
    const first = page();
    fireEvent.click(launcher());
    const thread = await within(panel()).findByRole("list", { name: "Conversation" });
    expect(within(thread).getByText(EARLIER.userText)).toBeTruthy();
    expect(storage.getItem("pc-conversation")).toBe("c-1");

    fireEvent.click(within(panel()).getByRole("button", { name: "New conversation" }));
    expect(within(panel()).queryByRole("list", { name: "Conversation" })).toBeNull();
    expect(storage.getItem("pc-conversation")).toBe("");

    // The next page, after the person started over: the old thread is not read or brought back.
    first.unmount();
    asked.length = 0;
    page();
    fireEvent.click(launcher());
    await questionBox();
    expect(asked).toEqual([]);
    expect(within(panel()).queryByRole("list", { name: "Conversation" })).toBeNull();
    await ask("Start fresh");
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).not.toHaveProperty("conversationId");
    // The new conversation is the one the next page picks up.
    await waitFor(() => expect(storage.getItem("pc-conversation")).toBe("c-2"));
  });

  it("still opens and asks when the browser refuses its storage", async () => {
    const refusing = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as Storage;
    vi.stubGlobal("sessionStorage", refusing);
    const { posted } = stubServer({ status: 200, body: { conversationId: "c-1", turns: [EARLIER] } });
    page();
    fireEvent.click(launcher());
    await within(panel()).findByRole("list", { name: "Conversation" });
    fireEvent.click(within(panel()).getByRole("button", { name: "New conversation" }));
    await ask("Is anything due today?");
    await waitFor(() => expect(posted).toHaveLength(1));
    await within(panel()).findByText("Done.");
  });

  it("keeps the thread across a close and an open, reading the newest conversation only once", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const { asked } = stubServer({ status: 200, body: { conversationId: "c-1", turns: [EARLIER] } });
    page();
    fireEvent.click(launcher());
    await within(panel()).findByRole("list", { name: "Conversation" });
    fireEvent.click(launcher());
    expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();
    await act(async () => {
      fireEvent.click(launcher());
    });
    expect(within(panel()).getByRole("list", { name: "Conversation" })).toBeTruthy();
    expect(asked.filter((u) => u === "/api/agent/recent")).toHaveLength(1);
  });
});
