// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatThread, type ChatMessage, type Part } from "./chat-thread";

afterEach(cleanup);

const suggestions = [
  { id: "s1", label: "Who has a problem on this week's paystub?" },
  { id: "s2", label: "Who owes us money past 60 days?" },
];

const thread: ChatMessage[] = [
  { id: "q1", role: "user", parts: [{ kind: "text", text: "Can the driver get an advance?" }] },
  {
    id: "a1",
    role: "agent",
    parts: [
      {
        kind: "steps",
        steps: [
          { id: "1", label: "Read 3 loads", state: "done" },
          { id: "2", label: "Fuel feed did not answer", state: "failed" },
          { id: "3", label: "Writing up the proposal", state: "running" },
        ],
      },
      {
        kind: "proposal",
        proposal: {
          id: "p-1",
          title: "Pay a $200.00 advance",
          impact: { cents: 20_000, direction: "out" },
          reasons: [],
          status: "proposed",
        },
      },
    ],
  },
];

describe("ChatThread", () => {
  it("offers the suggestions only before the first message", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <ChatThread messages={[]} suggestions={suggestions} onPick={onPick} composer={{ onSubmit: () => undefined }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: suggestions[1].label }));
    expect(onPick).toHaveBeenCalledWith("s2");

    rerender(<ChatThread messages={thread} suggestions={suggestions} onPick={onPick} composer={{}} />);
    expect(screen.queryByRole("button", { name: suggestions[0].label })).toBeNull();
    expect(screen.getByText("Can the driver get an advance?")).toBeTruthy();
  });

  it("names each step's state and announces the newest step", () => {
    render(<ChatThread messages={thread} composer={{}} />);
    expect(screen.getByText("Read 3 loads").textContent).toContain(", done");
    expect(screen.getByText("Fuel feed did not answer").textContent).toContain(", failed");
    expect(screen.getByText("Writing up the proposal").textContent).toContain(", working");
    const live = screen.getByTestId("step-announcer");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("Writing up the proposal, working");
  });

  it("renders a proposal part as a card", () => {
    render(<ChatThread messages={thread} composer={{}} />);
    expect(screen.getByRole("article", { name: "Pay a $200.00 advance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve $200.00" })).toBeTruthy();
  });

  it("shows a proposal's record the link rules do not know as plain text instead of failing", () => {
    const messages: ChatMessage[] = [
      {
        id: "a2",
        role: "agent",
        parts: [
          {
            kind: "proposal",
            proposal: {
              id: "p-2",
              title: "Move a payment",
              impact: { cents: 0, direction: "none" },
              reasons: [{ text: "Applied twice", source: { table: "users", id: "U-1" } }],
              status: "proposed",
            },
          },
        ],
      },
    ];
    render(<ChatThread messages={messages} composer={{}} />);
    const card = screen.getByRole("article", { name: "Move a payment" });
    expect(within(card).getByText("Users U-1").closest("a")).toBeNull();
    expect(within(card).queryAllByRole("link")).toHaveLength(0);
  });

  it("keeps an open confirm row with its own proposal when another part arrives before it", () => {
    const proposal = (id: string, title: string): Part => ({
      kind: "proposal",
      proposal: { id, title, impact: { cents: 20_000, direction: "out" }, reasons: [], status: "proposed" },
    });
    const agent = (parts: Part[]): ChatMessage[] => [{ id: "a3", role: "agent", parts }];
    const first = proposal("p-a", "Pay advance A");
    const { rerender } = render(<ChatThread messages={agent([first])} composer={{}} />);
    const cardA = screen.getByRole("article", { name: "Pay advance A" });
    fireEvent.click(within(cardA).getByRole("button", { name: "Approve $200.00" }));
    expect(within(cardA).getByRole("group", { name: "Confirm approval" })).toBeTruthy();

    rerender(<ChatThread messages={agent([proposal("p-b", "Pay advance B"), first])} composer={{}} />);
    const newcomer = screen.getByRole("article", { name: "Pay advance B" });
    expect(within(newcomer).queryByRole("group", { name: "Confirm approval" })).toBeNull();
    const opened = screen.getByRole("article", { name: "Pay advance A" });
    expect(within(opened).getByRole("group", { name: "Confirm approval" })).toBeTruthy();
  });
});
