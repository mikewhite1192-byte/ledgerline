// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_LIMIT, TOAST_TIMEOUT_MS, ToastProvider, useToast, type ToastInput } from "./toast";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Fire({ input }: { input: ToastInput }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast(input)}>
      {input.title}
    </button>
  );
}

function setup(...inputs: ToastInput[]) {
  render(
    <ToastProvider>
      {inputs.map((input) => (
        <Fire key={input.title} input={input} />
      ))}
    </ToastProvider>,
  );
  const region = screen.getByRole("status", { name: "Notifications" });
  const fire = (title: string) => fireEvent.click(screen.getByRole("button", { name: title }));
  const shown = () => within(region).queryAllByRole("listitem").map((li) => li.querySelector("p")?.textContent);
  return { region, fire, shown };
}

describe("toasts", () => {
  it("live in one polite status region", () => {
    const { region } = setup({ title: "Saved" });
    expect(region.getAttribute("aria-live")).toBe("polite");
  });

  it("lets a success toast leave after 6 seconds", () => {
    const { fire, shown } = setup({ title: "Approved", tone: "success" });
    fire("Approved");
    expect(shown()).toEqual(["Approved"]);
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1));
    expect(shown()).toEqual(["Approved"]);
    act(() => vi.advanceTimersByTime(1));
    expect(shown()).toEqual([]);
  });

  it("keeps a destructive toast until it is dismissed", () => {
    const { region, fire, shown } = setup({ title: "Payment failed", tone: "destructive" });
    fire("Payment failed");
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 10));
    expect(shown()).toEqual(["Payment failed"]);
    fireEvent.click(within(region).getByRole("button", { name: "Dismiss" }));
    expect(shown()).toEqual([]);
  });

  it("shows at most three, dropping the oldest", () => {
    const tones = ["one", "two", "three", "four"].map((title) => ({ title, tone: "warning" as const }));
    const { fire, shown } = setup(...tones);
    for (const t of tones) fire(t.title);
    expect(TOAST_LIMIT).toBe(3);
    expect(shown()).toEqual(["two", "three", "four"]);
  });
});

describe("useToast", () => {
  it("fails loudly without a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Fire input={{ title: "x" }} />)).toThrow("ToastProvider");
    vi.mocked(console.error).mockRestore();
  });
});
