// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartSweep } from "./start-sweep";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

// "Run sweep now" never names a week (D-090): the start picks the newest open week after the pay
// week roll, so a week opened by this press is the one swept.
describe("StartSweep", () => {
  it("starts a run with only its run id and goes to the run's page", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ runId: "r-1" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<StartSweep hasOpenWeek running={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Run sweep now" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/sweep/r-1"));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual(["runId"]);
  });

  it("stays off with no open week or with a run going", () => {
    const { rerender } = render(<StartSweep hasOpenWeek={false} running={false} />);
    expect(screen.getByRole("button", { name: "Run sweep now" })).toHaveProperty("disabled", true);
    rerender(<StartSweep hasOpenWeek running />);
    expect(screen.getByRole("button", { name: "Run sweep now" })).toHaveProperty("disabled", true);
  });
});
