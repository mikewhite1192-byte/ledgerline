// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outcomeSentence } from "@/lib/advances/reasons";
import { RecordActionButtons } from "./record-actions";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

const ADVANCE = "22222222-2222-4222-8222-222222222222";
const NONE = { retry: false, check: false, post: false };

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const summary = (checked: number) => ({ checked, confirmed: 0, failed: 0, stillUnknown: checked, skipped: 0, errors: 0 });

describe("the advance page's buttons", () => {
  it("says a send too new to read back is waiting, not that nothing was waiting", async () => {
    const fetch = answer(200, { ok: true, summary: summary(0), tooNew: 1 });
    render(<RecordActionButtons advanceId={ADVANCE} actions={{ ...NONE, check: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Check pending" }));
    expect(
      (await screen.findByRole("status")).textContent,
    ).toBe("The payout or post was sent less than a minute ago, too soon to check. Check again in a minute.");
    expect(fetch).toHaveBeenCalledWith(`/api/advances/${ADVANCE}/reconcile`, expect.objectContaining({ method: "POST" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says nothing was waiting only when nothing is", async () => {
    answer(200, { ok: true, summary: summary(0), tooNew: 0 });
    render(<RecordActionButtons advanceId={ADVANCE} actions={{ ...NONE, check: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Check pending" }));
    expect((await screen.findByRole("status")).textContent).toBe("Nothing was waiting to be checked.");
  });

  it("keeps the notice once the page reads the advance again and no button is left", async () => {
    answer(409, { error: "payout_failed", retryable: true });
    const { rerender } = render(<RecordActionButtons advanceId={ADVANCE} actions={{ ...NONE, retry: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry payout" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(outcomeSentence("payout_failed"));
    expect(refresh).toHaveBeenCalledTimes(1);
    // The last allowed attempt failed: the refreshed page offers no button at all.
    rerender(<RecordActionButtons advanceId={ADVANCE} actions={NONE} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(outcomeSentence("payout_failed"));
  });

  it("keeps a success notice too, when the payout is paid and posting is off", async () => {
    answer(200, { ok: true, status: "paid" });
    const { rerender } = render(<RecordActionButtons advanceId={ADVANCE} actions={{ ...NONE, retry: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry payout" }));
    expect((await screen.findByRole("status")).textContent).toBe("Paid.");
    rerender(<RecordActionButtons advanceId={ADVANCE} actions={NONE} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Paid.");
  });

  it("renders nothing when there is no button and no notice", () => {
    const { container } = render(<RecordActionButtons advanceId={ADVANCE} actions={NONE} />);
    expect(container.innerHTML).toBe("");
  });
});
