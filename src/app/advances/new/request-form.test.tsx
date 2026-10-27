// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/app/toast";
import { RequestForm } from "./request-form";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

// The app puts every page under the toast holder; the form says where the answer went through it.
function renderForm(disabled = false) {
  return render(
    <ToastProvider>
      <RequestForm drivers={DRIVERS} disabled={disabled} />
    </ToastProvider>,
  );
}

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
    renderForm();
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

describe("sending an advance request", () => {
  it("names what the button does, then says where the answer is before it moves to Home", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/advances/request") return new Response(JSON.stringify({ ok: true, status: "done" }), { status: 200 });
      const { driverId } = JSON.parse(String(init.body)) as { driverId: string };
      const s = SUGGESTED[driverId];
      const suggestion = { armed: s.armed, maxCents: s.cents, suggestedCents: s.cents, feeCents: 0, load: null };
      return new Response(JSON.stringify({ loads: [], suggestion }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    renderForm();
    const amount = screen.getByLabelText("Amount") as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: A } });
    await waitFor(() => expect(amount.value).toBe("300.00"));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "fuel" } });
    fireEvent.click(screen.getByRole("button", { name: "Check this request" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    const sent = fetch.mock.calls.find(([url]) => url === "/api/advances/request");
    expect(JSON.parse(String(sent?.[1].body))).toEqual({ driverId: A, amountCents: 30_000, category: "fuel" });
    const toast = screen.getByRole("status", { name: "Notifications" });
    expect(toast.textContent).toContain("Request checked");
    expect(toast.textContent).toContain("The answer appears on Home.");
  });

  it("stays on the form with a plain sentence when the request is refused, and shows no toast", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/advances/request"
          ? new Response(JSON.stringify({ error: "busy" }), { status: 409 })
          : new Response(JSON.stringify({ loads: [], suggestion: { armed: true, maxCents: 30_000, suggestedCents: 30_000, feeCents: 0, load: null } }), { status: 200 }),
      ),
    );
    renderForm();
    const amount = screen.getByLabelText("Amount") as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: A } });
    await waitFor(() => expect(amount.value).toBe("300.00"));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "fuel" } });
    fireEvent.click(screen.getByRole("button", { name: "Check this request" }));

    await screen.findByText("The agent is answering another question. Try again in a moment.");
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Notifications" }).textContent).not.toContain("Request checked");
  });

  // The route answers 200 once the turn ends, even when the turn failed or stopped early; only a
  // finished turn is a done check, and a reply without a readable status is not one either.
  it.each([
    ["failed", JSON.stringify({ ok: true, status: "failed" })],
    ["stopped early", JSON.stringify({ ok: true, status: "partial" })],
    ["unreadable", "not json"],
  ])("stays on the form and says where to look when the turn is %s, and shows no toast", async (_case, reply) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/advances/request"
          ? new Response(reply, { status: 200 })
          : new Response(JSON.stringify({ loads: [], suggestion: { armed: true, maxCents: 30_000, suggestedCents: 30_000, feeCents: 0, load: null } }), { status: 200 }),
      ),
    );
    renderForm();
    const amount = screen.getByLabelText("Amount") as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: A } });
    await waitFor(() => expect(amount.value).toBe("300.00"));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "fuel" } });
    fireEvent.click(screen.getByRole("button", { name: "Check this request" }));

    await screen.findByText("The agent did not finish checking this request. Open Home to see what it found before trying again.");
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Notifications" }).textContent).not.toContain("Request checked");
  });
});
