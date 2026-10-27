// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckPending, CodeReveal } from "./code-actions";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

const CODE = "22222222-2222-4222-8222-222222222222";

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("Show code", () => {
  it("shows the ten digits only after the press, copies them, and Hide clears them", async () => {
    const fetch = answer(200, { ok: true, code: "0123456789", expiresAt: "2026-10-29T15:00:00.000Z" });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container } = render(<CodeReveal codeId={CODE} />);
    expect(container.textContent).not.toMatch(/\d{5}/);
    fireEvent.click(screen.getByRole("button", { name: "Show code" }));
    expect(await screen.findByText("01234 56789")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(`/api/money-codes/${CODE}/reveal`, expect.objectContaining({ method: "POST" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });
    expect(writeText).toHaveBeenCalledWith("0123456789");
    expect(screen.getByRole("status").textContent).toContain("Copied.");
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(container.textContent).not.toMatch(/\d{5}/);
    expect(screen.getByRole("button", { name: "Show code" })).toBeTruthy();
  });

  it("says a refusal in its own words and shows no digits", async () => {
    answer(409, { error: "code_expired", retryable: false });
    const { container } = render(<CodeReveal codeId={CODE} />);
    fireEvent.click(screen.getByRole("button", { name: "Show code" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This code expired. Request a new one if the driver still needs it.");
    expect(container.textContent).not.toMatch(/\d{5}/);
  });

  it("never shows a reply that is not ten digits", async () => {
    answer(200, { ok: true, code: "<b>not a code</b>" });
    const { container } = render(<CodeReveal codeId={CODE} />);
    fireEvent.click(screen.getByRole("button", { name: "Show code" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The server could not be reached. Nothing changed; try again in a minute.");
    expect(container.textContent).not.toContain("not a code");
  });
});

describe("Check pending", () => {
  it("says what the read-back settled and reads the page again", async () => {
    const fetch = answer(200, { ok: true, summary: { checked: 1, confirmed: 1, failed: 0, stillUnknown: 0 }, tooNew: 0, stillWaiting: 0 });
    render(<CheckPending codeId={CODE} />);
    fireEvent.click(screen.getByRole("button", { name: "Check pending" }));
    expect((await screen.findByRole("status")).textContent).toBe("Confirmed. The code is issued and its paystub lines are added.");
    expect(fetch).toHaveBeenCalledWith(`/api/money-codes/${CODE}/check`, expect.objectContaining({ method: "POST" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says a send too new to read back is waiting, not that nothing was waiting", async () => {
    answer(200, { ok: true, summary: { checked: 0, confirmed: 0, failed: 0, stillUnknown: 0 }, tooNew: 1, stillWaiting: 0 });
    render(<CheckPending codeId={CODE} />);
    fireEvent.click(screen.getByRole("button", { name: "Check pending" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "The code was asked for less than a minute ago, too soon to check. Check again in a minute.",
    );
  });

  it("says a lost reply as not reached, never as nothing", async () => {
    answer(503, "not json");
    render(<CheckPending codeId={CODE} />);
    fireEvent.click(screen.getByRole("button", { name: "Check pending" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The server could not be reached. Nothing changed; try again in a minute.");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
