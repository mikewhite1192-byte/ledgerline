// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_NOT_CONFIRMED, CHECK_NOTICE, explainMissing } from "@/lib/cash/labels";
import { CashVerdict } from "./cash-verdict";
import { CHECK_LABEL, CheckCashButton } from "./check-cash-button";

// The Cash page's button and verdict line: one POST per press, fixed sentences for every refusal,
// a lost reply never read as "nothing saved", and the page read back whatever the answer. No
// network: fetch is a stand-in.

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("Check Friday's cash", () => {
  it("posts once, says nothing on success and reads the page back", async () => {
    const fetch = answer(200, { checkId: "6b1c9d2e-3f4a-4b5c-8d6e-7f8a9b0c1d2e" });
    render(<CheckCashButton />);
    fireEvent.click(screen.getByRole("button", { name: CHECK_LABEL }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/cash/check", expect.objectContaining({ method: "POST" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says each refusal in its own fixed sentence", async () => {
    for (const category of ["balance_missing", "pay_run_unknown", "more_than_one_open_period", "disabled"]) {
      answer(409, { error: category });
      const view = render(<CheckCashButton />);
      fireEvent.click(screen.getByRole("button", { name: CHECK_LABEL }));
      expect((await screen.findByRole("status")).textContent).toBe(CHECK_NOTICE[category]);
      view.unmount();
    }
  });

  it("never says nothing was saved when the reply is lost or the server failed", async () => {
    answer(503, { error: "unavailable", retryable: true });
    const view = render(<CheckCashButton />);
    fireEvent.click(screen.getByRole("button", { name: CHECK_LABEL }));
    expect((await screen.findByRole("status")).textContent).toBe(CHECK_NOT_CONFIRMED);
    view.unmount();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    render(<CheckCashButton />);
    fireEvent.click(screen.getByRole("button", { name: CHECK_LABEL }));
    const text = (await screen.findByRole("status")).textContent ?? "";
    expect(text).toBe(CHECK_NOT_CONFIRMED);
    expect(text).not.toMatch(/Nothing was saved/);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("CashVerdict", () => {
  it("says short by the gap, or covered with what is to spare, for the pay day", () => {
    const short = render(<CashVerdict gapCents={-680_000} day="Friday, Nov 6" />);
    expect(screen.getByText("Short by $6,800.00 for Friday, Nov 6")).toBeTruthy();
    short.unmount();
    render(<CashVerdict gapCents={214_000} day="Friday, Nov 6" />);
    expect(screen.getByText("Covered, $2,140.00 to spare for Friday, Nov 6")).toBeTruthy();
  });
});

describe("explainMissing", () => {
  it("says why the engine's sentence shows, and nothing when there was no attempt", () => {
    expect(explainMissing(null)).toBeNull();
    expect(explainMissing("figures")).toMatch(/dollar amount the engine did not give/);
    expect(explainMissing("some_new_category")).toMatch(/could not be used/);
  });
});
