// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { TurnView } from "@/lib/agent/view";
import { AgentLauncher } from "./agent-launcher";
import type { AgentPanelConfig } from "./agent-panel";
import type { PageFocus } from "./page-focus";
import type { AgentOpening } from "./panel-context";
import { greetingLine } from "./words";

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
  // A test that set the address's hash puts it back.
  window.history.replaceState(null, "", window.location.pathname);
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
  greeting: greetingLine("Test Carrier"),
};

const SUGGESTIONS = [
  { id: "past-60", label: "Which customers are past 60 days?", reason: "Lists the invoices past 60 days." },
];

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

function page(focus?: PageFocus, opts: { opening?: AgentOpening; extra?: ReactNode } = {}) {
  return render(
    <AgentLauncher config={CONFIG} focus={focus} suggestions={SUGGESTIONS} opening={opts.opening}>
      <main>
        <label>
          Search drivers
          <input />
        </label>
        {opts.extra}
      </main>
    </AgentLauncher>,
  );
}

const launcher = () => screen.getByRole("button", { name: "Ask the agent" });
const panel = () => screen.getByRole("dialog", { name: "Agent" }) as HTMLDialogElement;
const questionBox = () => within(panel()).findByRole("textbox", { name: "Your question" });

// The conversation menu's one item, once the thread has a first question to leave. jsdom leaves a
// closed <details> reachable, so it is opened the way a click on its title would.
async function startOver() {
  const menu = panel().querySelector("details");
  if (!menu) throw new Error("no conversation menu");
  menu.open = true;
  const item = within(panel()).getByRole("button", { name: "New conversation" }) as HTMLButtonElement;
  await waitFor(() => expect(item.disabled).toBe(false));
  fireEvent.click(item);
}

async function ask(text: string) {
  fireEvent.change(await questionBox(), { target: { value: text } });
  fireEvent.click(within(panel()).getByRole("button", { name: "Send" }));
}

describe("the agent launcher", () => {
  it("opens the card beside the page and minimizes it again, the cursor back on the button", async () => {
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
    // The card covers the button's corner, so the button is hidden while it is open.
    expect(launcher().className).toContain("invisible");
    expect(within(panel()).getByText("Beta")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: "Close the agent" })).toBeNull();
    await waitFor(async () => expect(document.activeElement).toBe(await questionBox()));

    fireEvent.click(within(panel()).getByRole("button", { name: "Minimize the agent" }));
    expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();
    expect(launcher().getAttribute("aria-expanded")).toBe("false");
    expect(launcher().className).not.toContain("invisible");
    expect(document.activeElement).toBe(launcher());
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

  it("opens as the modal sheet on a phone, closed by its X", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }) as MediaQueryList);
    stubServer(EMPTY_RECENT);
    page();
    fireEvent.click(launcher());
    expect(opened).toEqual(["modal"]);
    await questionBox();
    // The sheet fills the phone; it neither grows nor minimizes, and the button stays as it is.
    expect(within(panel()).queryByRole("button", { name: "Expand the agent" })).toBeNull();
    expect(within(panel()).queryByRole("button", { name: "Minimize the agent" })).toBeNull();
    expect(launcher().className).not.toContain("invisible");
    fireEvent.click(within(panel()).getByRole("button", { name: "Close the agent" }));
    expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();
    expect(document.activeElement).toBe(launcher());
  });

  it("grows when expanded and opens at its usual size again after a minimize", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    stubServer(EMPTY_RECENT);
    page();
    fireEvent.click(launcher());
    await questionBox();
    expect(panel().hasAttribute("data-expanded")).toBe(false);
    const grow = within(panel()).getByRole("button", { name: "Expand the agent" });
    expect(grow.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(grow);
    expect(panel().hasAttribute("data-expanded")).toBe(true);
    const shrink = within(panel()).getByRole("button", { name: "Shrink the agent" });
    expect(shrink.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(panel()).getByRole("button", { name: "Minimize the agent" }));
    fireEvent.click(launcher());
    expect(panel().hasAttribute("data-expanded")).toBe(false);
    expect(within(panel()).getByRole("button", { name: "Expand the agent" })).toBeTruthy();
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
    // A refusal that still carries turns: only a clean 200 is ever shown.
    const { asked } = stubServer({ status: 409, body: { conversationId: "c-1", turns: [EARLIER] } });
    page();
    fireEvent.click(launcher());
    await questionBox();
    expect(asked).toEqual(["/api/agent/recent"]);
    expect(within(panel()).queryByRole("alert")).toBeNull();
    expect(within(panel()).queryByRole("list", { name: "Conversation" })).toBeNull();
    expect(within(panel()).queryByText(EARLIER.userText)).toBeNull();
    expect(within(panel()).getByRole("heading", { name: "Hey, Test Carrier. How can I be helpful?" })).toBeTruthy();
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

    await startOver();
    expect(within(panel()).queryByRole("list", { name: "Conversation" })).toBeNull();
    expect(storage.getItem("pc-conversation")).toBe("left:c-1");

    // The next page, while the newest conversation is still the one left: it is not brought back.
    first.unmount();
    asked.length = 0;
    page();
    fireEvent.click(launcher());
    await questionBox();
    expect(asked).toEqual(["/api/agent/recent"]);
    expect(within(panel()).queryByRole("list", { name: "Conversation" })).toBeNull();
    expect(within(panel()).queryByText(EARLIER.userText)).toBeNull();
    await ask("Start fresh");
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).not.toHaveProperty("conversationId");
    // The new conversation is the one the next page picks up.
    await waitFor(() => expect(storage.getItem("pc-conversation")).toBe("c-2"));
  });

  it("shows a newer conversation asked on Home after New conversation in the panel", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    const recent = { status: 200, body: { conversationId: "c-1", turns: [EARLIER] } as unknown };
    stubServer(recent);
    const first = page();
    fireEvent.click(launcher());
    await within(panel()).findByRole("list", { name: "Conversation" });
    await startOver();
    expect(storage.getItem("pc-conversation")).toBe("left:c-1");
    first.unmount();

    // On Home the person asks again, so the newest conversation is no longer the one left.
    const fromHome: TurnView = { ...EARLIER, id: "t-3", conversationId: "c-3", userText: "Who is behind on loads?" };
    recent.body = { conversationId: "c-3", turns: [fromHome] };
    page(FOCUS);
    fireEvent.click(launcher());
    const thread = await within(panel()).findByRole("list", { name: "Conversation" });
    expect(within(thread).getByText(fromHome.userText)).toBeTruthy();
    expect(storage.getItem("pc-conversation")).toBe("c-3");
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
    await startOver();
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

  it("opens as the page loads with the box filled when the page asks, and sends nothing until the person does", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const { posted } = stubServer(EMPTY_RECENT);
    page(undefined, { opening: { draft: "Which customers are past 60 days?", help: "Edit it before you send." } });
    expect(panel().open).toBe(true);
    const box = (await questionBox()) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Which customers are past 60 days?"));
    expect(within(panel()).getByText("Edit it before you send.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(posted).toHaveLength(0);
  });

  it("opens on a new conversation for ?new=1, leaving the newest one for the next page too", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    stubServer({ status: 200, body: { conversationId: "c-1", turns: [EARLIER] } });
    page(undefined, { opening: { fresh: true } });
    expect(panel().open).toBe(true);
    await questionBox();
    await waitFor(() => expect(storage.getItem("pc-conversation")).toBe("left:c-1"));
    expect(within(panel()).queryByRole("list", { name: "Conversation" })).toBeNull();
    expect(within(panel()).queryByText(EARLIER.userText)).toBeNull();
  });

  it("opens when the address ends in #ask, on arrival and when the hash changes to it", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    stubServer(EMPTY_RECENT);
    window.history.replaceState(null, "", "#ask");
    const first = page();
    expect(panel().open).toBe(true);
    await waitFor(async () => expect(document.activeElement).toBe(await questionBox()));
    first.unmount();

    window.history.replaceState(null, "", window.location.pathname);
    page();
    expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();
    window.history.replaceState(null, "", "#ask");
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(panel().open).toBe(true);
  });

  it("opens and scrolls to the card a Needs you row links to, and stays closed for any other hash", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    stubServer(EMPTY_RECENT);
    const cardId = "card-22222222-2222-4222-8222-222222222222";
    const scrolled: unknown[] = [];
    window.history.replaceState(null, "", "#card-nope");
    const first = page();
    expect(screen.queryByRole("dialog", { name: "Agent" })).toBeNull();
    first.unmount();

    window.history.replaceState(null, "", `#${cardId}`);
    page(undefined, { extra: <div id={cardId}>A proposal</div> });
    const card = document.getElementById(cardId);
    if (!card) throw new Error("no card");
    card.scrollIntoView = (arg?: boolean | ScrollIntoViewOptions) => void scrolled.push(arg);
    expect(panel().open).toBe(true);
    await waitFor(() => expect(scrolled).toEqual([{ block: "center" }]));
  });

  it("brings back a conversation left with New conversation when a card link points into it", async () => {
    const storage = memoryStorage({ "pc-conversation": "left:c-1" });
    vi.stubGlobal("sessionStorage", storage);
    stubServer({ status: 200, body: { conversationId: "c-1", turns: [EARLIER] } });
    window.history.replaceState(null, "", "#card-22222222-2222-4222-8222-222222222222");
    page();
    expect(panel().open).toBe(true);
    const thread = await within(panel()).findByRole("list", { name: "Conversation" });
    expect(within(thread).getByText(EARLIER.userText)).toBeTruthy();
    await waitFor(() => expect(storage.getItem("pc-conversation")).not.toBe("left:c-1"));
  });

  it("fills the box from the page's ask and still scrolls to the card when the address has both", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const { posted } = stubServer(EMPTY_RECENT);
    const cardId = "card-33333333-3333-4333-8333-333333333333";
    const scrolled: unknown[] = [];
    window.history.replaceState(null, "", `#${cardId}`);
    page(undefined, { opening: { draft: "Which customers are past 60 days?" }, extra: <div id={cardId}>A proposal</div> });
    const card = document.getElementById(cardId);
    if (!card) throw new Error("no card");
    card.scrollIntoView = (arg?: boolean | ScrollIntoViewOptions) => void scrolled.push(arg);
    const box = (await questionBox()) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Which customers are past 60 days?"));
    await waitFor(() => expect(scrolled).toEqual([{ block: "center" }]));
    expect(posted).toHaveLength(0);
  });
});
