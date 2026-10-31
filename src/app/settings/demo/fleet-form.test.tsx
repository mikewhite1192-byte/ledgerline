// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLEET_MESSAGES, MoveFleetForm } from "./fleet-form";

const { moveFleetAction } = vi.hoisted(() => ({ moveFleetAction: vi.fn() }));
vi.mock("./fleet-action", () => ({ moveFleetAction }));

afterEach(() => {
  cleanup();
  moveFleetAction.mockReset();
});

const press = () => fireEvent.click(screen.getByRole("button", { name: "Move the fleet" }));

describe("the move the fleet form", () => {
  it("says the moves may have gone through when the database did not confirm them", async () => {
    moveFleetAction.mockResolvedValue({ ok: false, category: "unknown" });
    render(<MoveFleetForm />);
    press();
    const text = (await screen.findByRole("alert")).textContent;
    expect(text).toBe(FLEET_MESSAGES.unknown);
    expect(text).toContain("may have gone through");
    expect(text).toContain("Check the load statuses before pressing again");
    expect(text).not.toContain("Nothing was changed");
  });

  it("says the switch is off", async () => {
    moveFleetAction.mockResolvedValue({ ok: false, category: "disabled" });
    render(<MoveFleetForm />);
    press();
    expect((await screen.findByRole("alert")).textContent).toBe(FLEET_MESSAGES.disabled);
    expect(FLEET_MESSAGES.disabled).toContain("switched off");
  });
});
