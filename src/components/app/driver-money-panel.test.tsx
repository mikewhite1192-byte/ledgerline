// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DriverIdentity } from "@/lib/advances/identity";
import { DriverMoneyPanel, holderWords, type PanelSend } from "./driver-money-panel";

afterEach(cleanup);

const DRIVER = "11111111-1111-4111-8111-111111111111";
const DEFAULT_CARD = "22222222-2222-4222-8222-222222222222";
const SPARE_CARD = "33333333-3333-4333-8333-333333333333";

const identity: DriverIdentity = {
  driverId: DRIVER,
  code: "BR-C01",
  name: "Sample Driver",
  activeTo: null,
  armed: { on: false, since: null },
  tmsIds: ["TMS-40217"],
  cards: [
    { id: DEFAULT_CARD, last4: "4417", status: "active", isDefault: true, holderKind: "named", portalName: null, testMode: true },
    { id: SPARE_CARD, last4: "0932", status: "active", isDefault: false, holderKind: "generic", portalName: "POOL CARD 3", testMode: true },
  ],
};

function sender(out: { ok: boolean; error: string | null } = { ok: true, error: null }) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const send: PanelSend = async (path, body) => {
    calls.push({ path, body });
    return out;
  };
  return { send, calls };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

describe("holderWords", () => {
  it("names the holder kind and a generic card's portal name", () => {
    expect(holderWords({ holderKind: "named", portalName: null })).toBe("In the driver's name");
    expect(holderWords({ holderKind: "generic", portalName: "POOL CARD 3" })).toBe("Generic card, portal name POOL CARD 3");
    expect(holderWords({ holderKind: "generic", portalName: null })).toBe("Generic card");
  });
});

describe("DriverMoneyPanel", () => {
  it("arms only after the confirm sentence, then says so and lets the page read again", async () => {
    const { send, calls } = sender();
    const onDone = vi.fn();
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="America/Chicago" send={send} onDone={onDone} />);
    expect(screen.getByText("Not armed")).toBeTruthy();
    fireEvent.click(button("Arm"));
    expect(calls).toEqual([]);
    expect(screen.getByText(/Arm Sample Driver\? Approved advances can then be paid to their default card\./)).toBeTruthy();
    fireEvent.click(button("Arm"));
    await waitFor(() => expect(screen.getByText("Armed. Advances can be paid to this driver.")).toBeTruthy());
    expect(calls).toEqual([{ path: `/api/drivers/${DRIVER}/arm`, body: { armed: true } }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("shows armed since a time in the carrier's zone and asks before disarming", async () => {
    const { send, calls } = sender();
    const armed = { ...identity, armed: { on: true, since: "2026-10-05T14:00:00.000Z" } };
    render(<DriverMoneyPanel identity={armed} canAdmin timezone="UTC" send={send} />);
    expect(screen.getByText(/^Armed since /)).toBeTruthy();
    fireEvent.click(button("Disarm"));
    expect(screen.getByText(/Disarm Sample Driver\? No advance can be paid to them/)).toBeTruthy();
    fireEvent.click(button("Never mind"));
    expect(calls).toEqual([]);
  });

  it("gives staff no arm or card buttons, and says who can", () => {
    render(<DriverMoneyPanel identity={identity} canAdmin={false} timezone="UTC" send={sender().send} />);
    expect(screen.getByText("Only an admin arms or disarms a driver.")).toBeTruthy();
    for (const name of ["Arm", "Make default", "Close", "Add card"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    // Any member may add an id.
    expect(button("Add id")).toBeTruthy();
  });

  it("marks the default card and words each holder", () => {
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={sender().send} />);
    expect(screen.getByText("Default")).toBeTruthy();
    expect(screen.getByText("In the driver's name")).toBeTruthy();
    expect(screen.getByText("Generic card, portal name POOL CARD 3")).toBeTruthy();
    // Make default is offered on the spare card only; both active cards can be closed.
    expect(screen.getAllByRole("button", { name: "Make default" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
    expect(screen.getByText("Dispatch system:", { exact: false })).toBeTruthy();
  });

  it("sends Make default and Close to the card's own routes", async () => {
    const { send, calls } = sender();
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={send} />);
    fireEvent.click(button("Make default"));
    await waitFor(() => expect(screen.getByText("Card ···· 0932 is now the default.")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.getByText("Closed card ···· 4417.")).toBeTruthy());
    expect(calls).toEqual([
      { path: `/api/drivers/${DRIVER}/cards/${SPARE_CARD}/default`, body: {} },
      { path: `/api/drivers/${DRIVER}/cards/${DEFAULT_CARD}/close`, body: {} },
    ]);
  });

  it("checks a new card before sending, and sends a generic card's portal name upper case", async () => {
    const { send, calls } = sender();
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={send} />);
    fireEvent.click(button("Add card"));
    fireEvent.change(screen.getByLabelText("Last four digits"), { target: { value: "12a4" } });
    fireEvent.click(button("Add card"));
    expect(screen.getByText("The card's last four digits.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Last four digits"), { target: { value: "1234" } });
    fireEvent.change(screen.getByLabelText("Card holder"), { target: { value: "generic" } });
    fireEvent.change(screen.getByLabelText("Portal name", { exact: false }), { target: { value: "J" } });
    fireEvent.click(button("Add card"));
    expect(screen.getByText(/Never a person's name/)).toBeTruthy();
    expect(calls).toEqual([]);
    fireEvent.change(screen.getByLabelText("Portal name", { exact: false }), { target: { value: " yard  card 2 " } });
    fireEvent.click(screen.getByLabelText("Make it the default card"));
    fireEvent.click(button("Add card"));
    await waitFor(() => expect(screen.getByText("Added the card, in test mode.")).toBeTruthy());
    expect(calls).toEqual([
      {
        path: `/api/drivers/${DRIVER}/cards`,
        body: { last4: "1234", holderKind: "generic", makeDefault: true, portalName: "YARD CARD 2" },
      },
    ]);
  });

  it("checks a dispatch id before sending, then sends it", async () => {
    const { send, calls } = sender();
    render(<DriverMoneyPanel identity={identity} canAdmin={false} timezone="UTC" send={send} />);
    fireEvent.click(button("Add id"));
    fireEvent.change(screen.getByLabelText("Dispatch id"), { target: { value: "has space" } });
    fireEvent.click(button("Save"));
    expect(screen.getByText(/Letters, digits, dots, dashes and underscores/)).toBeTruthy();
    expect(calls).toEqual([]);
    fireEvent.change(screen.getByLabelText("Dispatch id"), { target: { value: " TMS-9 " } });
    fireEvent.click(button("Save"));
    await waitFor(() => expect(screen.getByText("Saved the dispatch id.")).toBeTruthy());
    expect(calls).toEqual([{ path: `/api/drivers/${DRIVER}/identities`, body: { system: "tms", externalId: "TMS-9" } }]);
  });

  it("shows a refusal as its fixed sentence, never the route's own text", async () => {
    const { send } = sender({ ok: false, error: "role" });
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={send} />);
    fireEvent.click(button("Arm"));
    fireEvent.click(button("Arm"));
    await waitFor(() => expect(screen.getByText("Only an admin can arm a driver or change their cards.")).toBeTruthy());
    cleanup();
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={sender({ ok: false, error: "<b>raw</b>" }).send} />);
    fireEvent.click(button("Make default"));
    await waitFor(() => expect(screen.getByText("That did not finish. Nothing was changed; try again.")).toBeTruthy());
  });

  it("says when no card or id is on file", () => {
    render(<DriverMoneyPanel identity={{ ...identity, tmsIds: [], cards: [] }} canAdmin timezone="UTC" send={sender().send} />);
    expect(screen.getByText("No dispatch id on file.")).toBeTruthy();
    expect(screen.getByText(/No fuel card on file/)).toBeTruthy();
  });
});
