// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TakeBack } from "./take-back";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

const ADVANCE = "22222222-2222-4222-8222-222222222222";

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const sentBody = (fetch: ReturnType<typeof answer>) =>
  JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as unknown;

describe("Take back on the advance page", () => {
  it("shows nothing when it is not offered", () => {
    const { container } = render(<TakeBack advanceId={ADVANCE} offered={false} paid stillOwedCents={20_500} />);
    expect(container.textContent).toBe("");
  });

  it("records a paid advance's amount, pre-filled with what is still owed, and says nothing left the card", async () => {
    const fetch = answer(200, { ok: true, changed: true, status: "paid" });
    render(<TakeBack advanceId={ADVANCE} offered paid stillOwedCents={20_500} />);
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect((screen.getByLabelText("Amount taken back") as HTMLInputElement).value).toBe("205.00");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "duplicate" } });
    fireEvent.click(screen.getByRole("button", { name: "Record take-back" }));
    expect((await screen.findByRole("status")).textContent).toBe("Recorded $205.00 taken back. Nothing was pulled off the card.");
    expect(fetch).toHaveBeenCalledWith(`/api/advances/${ADVANCE}/take-back`, expect.objectContaining({ method: "POST" }));
    expect(sentBody(fetch)).toEqual({ amountCents: 20_500, reason: "duplicate" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("checks the amount and the reason before sending anything", () => {
    const fetch = answer(200, {});
    render(<TakeBack advanceId={ADVANCE} offered paid stillOwedCents={20_500} />);
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    fireEvent.change(screen.getByLabelText("Amount taken back"), { target: { value: "205.01" } });
    fireEvent.click(screen.getByRole("button", { name: "Record take-back" }));
    expect(screen.getByText("Dollars and cents, above zero and up to $205.00.")).toBeTruthy();
    expect(screen.getByText("Pick a reason.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Amount taken back"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Record take-back" }));
    expect(screen.getByText("Dollars and cents, above zero and up to $205.00.")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels an advance not yet paid with no amount field, sending zero", async () => {
    const fetch = answer(200, { ok: true, changed: true, status: "cancelled" });
    render(<TakeBack advanceId={ADVANCE} offered paid={false} stillOwedCents={30_000} />);
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect(screen.queryByLabelText("Amount taken back")).toBeNull();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "wrong_driver" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel this advance" }));
    expect((await screen.findByRole("status")).textContent).toBe("Cancelled. Nothing was paid, so nothing was taken back.");
    expect(sentBody(fetch)).toEqual({ amountCents: 0, reason: "wrong_driver" });
  });

  it("says a repeat changed nothing", async () => {
    answer(200, { ok: true, changed: false, status: "paid" });
    render(<TakeBack advanceId={ADVANCE} offered paid stillOwedCents={20_500} />);
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "duplicate" } });
    fireEvent.click(screen.getByRole("button", { name: "Record take-back" }));
    expect((await screen.findByRole("status")).textContent).toBe("This was already recorded. Nothing changed.");
  });

  it("shows a refusal as its fixed sentence, and an unreadable answer as a retry", async () => {
    answer(403, { error: "role" });
    render(<TakeBack advanceId={ADVANCE} offered paid stillOwedCents={20_500} />);
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "duplicate" } });
    fireEvent.click(screen.getByRole("button", { name: "Record take-back" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Taking back an advance this large needs an admin.");
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    render(<TakeBack advanceId={ADVANCE} offered paid stillOwedCents={20_500} />);
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "duplicate" } });
    fireEvent.click(screen.getByRole("button", { name: "Record take-back" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("network");
    expect(alert.textContent?.length).toBeGreaterThan(0);
  });
});
