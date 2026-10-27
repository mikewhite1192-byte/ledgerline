// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESET_MESSAGES, DemoResetForm } from "./reset-form";

const { resetDemoAction } = vi.hoisted(() => ({ resetDemoAction: vi.fn() }));
vi.mock("./reset-action", () => ({ resetDemoAction }));

afterEach(() => {
  cleanup();
  resetDemoAction.mockReset();
});

const press = () => {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Reset the demo" }));
};

describe("the demo reset form", () => {
  it("sends the ticked box and shows the counts and the hero's net", async () => {
    resetDemoAction.mockResolvedValue({ ok: true, carrier: "blue-ridge", cleared: 17, rewritten: 4064, heroNetCents: 222_500 });
    render(<DemoResetForm />);
    expect(screen.getByRole("checkbox")).toHaveProperty("required", true);
    press();
    const done = await screen.findByRole("status");
    expect(done.textContent).toBe(
      "The demo is back to its seeded week4064 records rewritten, 17 cleared. The hero driver's open week nets $2,225.00.",
    );
    expect(resetDemoAction).toHaveBeenCalledTimes(1);
    const form = resetDemoAction.mock.calls[0][1] as FormData;
    expect(form.get("confirm")).toBe("reset");
  });

  it("leaves the hero line out for a carrier with no hero", async () => {
    resetDemoAction.mockResolvedValue({ ok: true, carrier: "prairie-wind", cleared: 0, rewritten: 3415, heroNetCents: null });
    render(<DemoResetForm />);
    press();
    expect((await screen.findByRole("status")).textContent).toBe(
      "The demo is back to its seeded week3415 records rewritten, 0 cleared.",
    );
  });

  it("shows a refusal's fixed message and its counts", async () => {
    const reasons = ["1 ledger row(s) still reserved, sent or unknown; settle them before a reset"];
    resetDemoAction.mockResolvedValue({ ok: false, category: "refused", reasons });
    render(<DemoResetForm />);
    press();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`${RESET_MESSAGES.refused}${reasons[0]}`);
  });

  it("shows only the fixed message for any other category", async () => {
    resetDemoAction.mockResolvedValue({ ok: false, category: "unknown" });
    render(<DemoResetForm />);
    press();
    expect((await screen.findByRole("alert")).textContent).toBe(RESET_MESSAGES.unknown);
  });
});
