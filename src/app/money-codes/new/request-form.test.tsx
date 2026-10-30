// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeRequestForm } from "./request-form";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: () => {} }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

const LOAD = "33333333-3333-4333-8333-333333333333";
const DOC = "44444444-4444-4444-8444-444444444444";
const LOADS = [{ id: LOAD, loadNumber: "PW-L20410", driverCode: "PW-D01", driverName: "Sam Rivera", status: "in_transit" as const }];
const RECEIPTS = [{ id: DOC, filename: "pw-l20410-lumper.webp", kind: "lumper_receipt" as const }];

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const form = () => render(<CodeRequestForm loads={LOADS} receipts={RECEIPTS} capCents={50_000} capWords="$500.00" />);

function fill(amount: string, purpose = "lumper", receipt = "") {
  fireEvent.change(screen.getByLabelText("Load"), { target: { value: LOAD } });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: amount } });
  fireEvent.change(screen.getByLabelText("For"), { target: { value: purpose } });
  fireEvent.change(screen.getByLabelText("Receipt (optional)"), { target: { value: receipt } });
}

describe("the Request a code form", () => {
  it("sends the load, the amount in integer cents, the purpose and the receipt, then opens the Money codes page", async () => {
    const fetch = answer(200, { ok: true, outcome: "created", proposalId: LOAD });
    form();
    fill("150", "lumper", DOC);
    fireEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/money-codes"));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/money-codes");
    expect(JSON.parse(String(init.body))).toEqual({ loadId: LOAD, amountCents: 15_000, purpose: "lumper", documentId: DOC });
  });

  it("sends no receipt as null", async () => {
    const fetch = answer(200, { ok: true, outcome: "created", proposalId: LOAD });
    form();
    fill("85.50", "repair");
    fireEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    await vi.waitFor(() => expect(push).toHaveBeenCalled());
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      loadId: LOAD,
      amountCents: 8_550,
      purpose: "repair",
      documentId: null,
    });
  });

  it("asks for each missing field and sends nothing, and holds an amount over the cap", async () => {
    const fetch = answer(200, {});
    form();
    fireEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    expect(await screen.findByText("Pick a load.")).toBeTruthy();
    expect(screen.getByText("Pick what the code is for.")).toBeTruthy();
    fill("500.01");
    fireEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    expect((await screen.findAllByText(/up to \$500\.00/)).length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says the pay rules' refusal in a fixed sentence and stays on the form", async () => {
    answer(409, { error: "receipt_total_differs", retryable: false });
    form();
    fill("140", "lumper", DOC);
    fireEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The amount does not equal the receipt's total.");
    expect(push).not.toHaveBeenCalled();
  });

  it("offers nothing to send while no load can take a code", () => {
    render(<CodeRequestForm loads={[]} receipts={[]} capCents={50_000} capWords="$500.00" />);
    expect(screen.getByText("No load is on the road or was delivered in the last three days.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send for approval" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
