// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestForm } from "./request-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const DRIVERS = [
  { id: A, code: "BR-D01", name: "Ann Example" },
  { id: B, code: "BR-D02", name: "Ben Example" },
  { id: C, code: "BR-D03", name: "Cal Example" },
];

// The suggestion route: A may take $300.00, B $250.00, and C is not armed.
const SUGGESTED: Record<string, { armed: boolean; cents: number }> = {
  [A]: { armed: true, cents: 30_000 },
  [B]: { armed: true, cents: 25_000 },
  [C]: { armed: false, cents: 0 },
};

function suggestRoute() {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const { driverId } = JSON.parse(String(init.body)) as { driverId: string };
    const s = SUGGESTED[driverId];
    const suggestion = { armed: s.armed, maxCents: s.cents, suggestedCents: s.cents, feeCents: 0, load: null };
    return new Response(JSON.stringify({ loads: [], suggestion }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("the advance request form's suggested amount", () => {
  it("replaces its own suggestion when another driver is picked, and never a typed amount", async () => {
    suggestRoute();
    render(<RequestForm drivers={DRIVERS} disabled={false} />);
    const driver = screen.getByLabelText("Driver");
    const amount = screen.getByLabelText("Amount") as HTMLInputElement;

    fireEvent.change(driver, { target: { value: A } });
    await waitFor(() => expect(amount.value).toBe("300.00"));
    fireEvent.change(driver, { target: { value: B } });
    await waitFor(() => expect(amount.value).toBe("250.00"));
    expect(screen.getByText("Suggested: $250.00")).toBeTruthy();

    // A driver nobody armed suggests nothing, so the last suggestion does not stay behind.
    fireEvent.change(driver, { target: { value: C } });
    await screen.findByText(/not armed to receive money/);
    expect(amount.value).toBe("");

    fireEvent.change(amount, { target: { value: "123" } });
    fireEvent.change(driver, { target: { value: A } });
    await screen.findByText("Suggested: $300.00");
    expect(amount.value).toBe("123");
  });
});
