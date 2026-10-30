// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_RESULT } from "@/lib/factoring/words";
import { CHECK_PENDING_LABEL, CheckPendingButton } from "./check-pending-button";

// Check pending says what the press found from the reply's own counts, and reads the page back.

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

const CHECK_URL = "/api/factoring/5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a/check";
const NONE = { checked: 0, confirmed: 0, failed: 0, stillUnknown: 0, skipped: 0, errors: 0 };

function answer(body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function press(): Promise<string> {
  render(<CheckPendingButton url={CHECK_URL} />);
  fireEvent.click(screen.getByRole("button", { name: CHECK_PENDING_LABEL }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  return screen.getByRole("status").textContent ?? "";
}

describe("Check pending on a factoring request", () => {
  it("says the check did not finish when a read-back errored, never that nothing is waiting", async () => {
    const fetch = answer({ summary: { ...NONE, checked: 1, errors: 1 }, tooNew: 0, stillWaiting: 0, status: "unknown" });
    expect(await press()).toBe(CHECK_RESULT.errors);
    expect(fetch).toHaveBeenCalledWith(CHECK_URL, expect.objectContaining({ method: "POST" }));
  });

  it("says nothing is waiting only when nothing errored either", async () => {
    answer({ summary: NONE, tooNew: 0, stillWaiting: 0, status: "funded" });
    expect(await press()).toBe(CHECK_RESULT.nothing);
  });
});
