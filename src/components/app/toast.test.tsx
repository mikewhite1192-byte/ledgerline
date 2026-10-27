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
  // The whole stack: the polite region and, beside it, the errors.
  const stack = region.parentElement as HTMLElement;
  const fire = (title: string) => fireEvent.click(screen.getByRole("button", { name: title }));
  const shown = () => within(stack).queryAllByRole("listitem").map((li) => li.querySelector("p")?.textContent);
  return { region, stack, fire, shown };
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
    const { stack, fire, shown } = setup({ title: "Payment failed", tone: "destructive" });
    fire("Payment failed");
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 10));
    expect(shown()).toEqual(["Payment failed"]);
    fireEvent.click(within(stack).getByRole("button", { name: "Dismiss" }));
    expect(shown()).toEqual([]);
  });

  it("keeps a toast with an action until it is acted on", () => {
    const onClick = vi.fn();
    const { region, fire, shown } = setup({ title: "Draft saved", tone: "success", action: { label: "Undo", onClick } });
    fire("Draft saved");
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 10));
    expect(shown()).toEqual(["Draft saved"]);
    fireEvent.click(within(region).getByRole("button", { name: "Undo" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual([]);
  });

  it("keeps a toast with an action until it is dismissed", () => {
    const onClick = vi.fn();
    const { region, fire, shown } = setup({ title: "Draft saved", action: { label: "Undo", onClick } });
    fire("Draft saved");
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 10));
    expect(shown()).toEqual(["Draft saved"]);
    fireEvent.click(within(region).getByRole("button", { name: "Dismiss" }));
    expect(onClick).not.toHaveBeenCalled();
    expect(shown()).toEqual([]);
  });

  it("pauses while the pointer is on a toast and gives it the full time again after", () => {
    const { region, fire, shown } = setup({ title: "Approved", tone: "success" });
    fire("Approved");
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1_000));
    const li = within(region).getByRole("listitem");
    fireEvent.pointerEnter(li);
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 10));
    expect(shown()).toEqual(["Approved"]);
    fireEvent.pointerLeave(li);
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1));
    expect(shown()).toEqual(["Approved"]);
    act(() => vi.advanceTimersByTime(1));
    expect(shown()).toEqual([]);
  });

  it("pauses while focus is inside a toast, even as it moves between its buttons", () => {
    const { region, fire, shown } = setup({ title: "Approved", tone: "success" });
    fire("Approved");
    const li = within(region).getByRole("listitem");
    const dismiss = within(region).getByRole("button", { name: "Dismiss" });
    fireEvent.focusIn(dismiss);
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 10));
    expect(shown()).toEqual(["Approved"]);
    fireEvent.focusOut(dismiss, { relatedTarget: li });
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 10));
    expect(shown()).toEqual(["Approved"]);
    fireEvent.focusOut(dismiss, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1));
    expect(shown()).toEqual(["Approved"]);
    act(() => vi.advanceTimersByTime(1));
    expect(shown()).toEqual([]);
  });

  it("shows at most three, dropping the oldest", () => {
    const tones = ["one", "two", "three", "four"].map((title) => ({ title, tone: "warning" as const }));
    const { fire, shown } = setup(...tones);
    for (const t of tones) fire(t.title);
    expect(TOAST_LIMIT).toBe(3);
    expect(shown()).toEqual(["two", "three", "four"]);
  });

  it("a destructive toast survives three later successes", () => {
    const later = ["one", "two", "three"].map((title) => ({ title, tone: "success" as const }));
    const { fire, shown } = setup({ title: "Payment failed", tone: "destructive" }, ...later);
    fire("Payment failed");
    for (const t of later) fire(t.title);
    expect(shown()).toHaveLength(TOAST_LIMIT);
    expect(shown()).toContain("Payment failed");
    expect(shown()).not.toContain("one");
  });

  it("announces an error at once as an alert and other news politely, each only once", () => {
    const { region, fire } = setup(
      { title: "Payment failed", tone: "destructive" },
      { title: "Saved", tone: "success" },
      { title: "Fuel feed is late", tone: "warning" },
    );
    fire("Payment failed");
    fire("Saved");
    fire("Fuel feed is late");
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("Payment failed");
    // Not inside any polite live region, so a screen reader reads it once.
    expect(region.contains(alerts[0])).toBe(false);
    expect(alerts[0].parentElement?.closest("[aria-live]")).toBeNull();
    expect(within(region).getByText("Saved")).toBeTruthy();
    expect(within(region).getByText("Fuel feed is late")).toBeTruthy();
  });
});

describe("useToast", () => {
  it("fails loudly without a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Fire input={{ title: "x" }} />)).toThrow("ToastProvider");
    vi.mocked(console.error).mockRestore();
  });
});
