// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostButton } from "./post-button";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

// Press the button with the server answering this payment record state; return the note it shows.
async function noteFor(state: string): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, state }), { status: 200, headers: { "content-type": "application/json" } })),
  );
  render(<PostButton url="/api/invoices/x/post" />);
  fireEvent.click(screen.getByRole("button", { name: "Post to QuickBooks" }));
  const status = screen.getByRole("status");
  await vi.waitFor(() => expect(status.textContent).not.toBe(""));
  return status.textContent ?? "";
}

describe("PostButton", () => {
  it("says sent only for a record that was sent", async () => {
    expect(await noteFor("sent")).toBe("Sent to QuickBooks. Waiting for QuickBooks to confirm it.");
    cleanup();
    expect(await noteFor("confirmed")).toBe("Sent and confirmed by QuickBooks.");
  });

  it("says a reserved record is waiting to send, never that it was sent", async () => {
    const note = await noteFor("reserved");
    expect(note).toBe("Waiting to send to QuickBooks.");
    expect(note).not.toMatch(/\bSent\b/);
  });

  it("claims neither sent nor not sent for an unknown outcome", async () => {
    const note = await noteFor("unknown");
    expect(note).toBe("Not confirmed yet. It may or may not be in QuickBooks, so check QuickBooks before trying again.");
    expect(note).not.toMatch(/\bsent\b/i);
  });
});
