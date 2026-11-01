// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivationChecklist } from "@/lib/advances/activation";
import type { DriverIdentity } from "@/lib/advances/identity";
import { DriverMoneyPanel, holderWords, statusWords, type PanelSend } from "./driver-money-panel";

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

describe("statusWords", () => {
  it("says active, a last day still to come or today, and a last day already past", () => {
    expect(statusWords(null, "2026-11-01")).toEqual({ tone: "success", text: "Active" });
    expect(statusWords("2026-11-01", "2026-11-01")).toEqual({ tone: "warning", text: "Last day Nov 1, 2026" });
    expect(statusWords("2026-11-20", "2026-11-01")).toEqual({ tone: "warning", text: "Last day Nov 20, 2026" });
    expect(statusWords("2026-10-31", "2026-11-01")).toEqual({ tone: "warning", text: "Departed, last day Oct 31, 2026" });
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

  it("shows no Status row while driver admin is off or without the carrier's today", () => {
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={sender().send} />);
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
    cleanup();
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={sender().send} statusAdminOn />);
    expect(screen.queryByText("Status")).toBeNull();
    cleanup();
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={sender().send} statusAdminOn today="not a date" />);
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("deactivates only after the confirm sentence, with the last day and note given", async () => {
    const { send, calls } = sender();
    const onDone = vi.fn();
    render(
      <DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={send} onDone={onDone} statusAdminOn today="2026-11-01" />,
    );
    expect(screen.getByText("Active")).toBeTruthy();
    fireEvent.click(button("Deactivate"));
    expect(calls).toEqual([]);
    expect(screen.getByText(/Deactivate Sample Driver\? They are disarmed now/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Last day/), { target: { value: "2026-11-05" } });
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: "  moving on  " } });
    fireEvent.click(button("Deactivate"));
    await waitFor(() => expect(screen.getByText("Deactivated. They are not armed, so no new money can go to this driver.")).toBeTruthy());
    expect(calls).toEqual([
      { path: `/api/drivers/${DRIVER}/status`, body: { active: false, effectiveOn: "2026-11-05", note: "moving on" } },
    ]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("deactivates on today when no day is given, and Never mind sends nothing", async () => {
    const { send, calls } = sender();
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={send} statusAdminOn today="2026-11-01" />);
    fireEvent.click(button("Deactivate"));
    fireEvent.click(button("Never mind"));
    expect(calls).toEqual([]);
    fireEvent.click(button("Deactivate"));
    fireEvent.click(button("Deactivate"));
    await waitFor(() => expect(calls).toEqual([{ path: `/api/drivers/${DRIVER}/status`, body: { active: false } }]));
  });

  it("reactivates a departed driver without arming them, and asks for no date", async () => {
    const { send, calls } = sender();
    const departed = { ...identity, activeTo: "2026-10-31" };
    render(<DriverMoneyPanel identity={departed} canAdmin timezone="UTC" send={send} statusAdminOn today="2026-11-01" />);
    expect(screen.getByText("Departed, last day Oct 31, 2026")).toBeTruthy();
    fireEvent.click(button("Reactivate"));
    expect(screen.getByText(/Reactivate Sample Driver\? They stay not armed/)).toBeTruthy();
    expect(screen.queryByLabelText(/Last day/)).toBeNull();
    fireEvent.click(button("Reactivate"));
    await waitFor(() =>
      expect(screen.getByText("Reactivated. They are not armed: an admin arms them again before any advance.")).toBeTruthy(),
    );
    expect(calls).toEqual([{ path: `/api/drivers/${DRIVER}/status`, body: { active: true } }]);
  });

  it("offers no Arm for a driver with a last day on file, says why, and still offers Disarm", () => {
    const leaving = { ...identity, activeTo: "2026-11-20" };
    render(<DriverMoneyPanel identity={leaving} canAdmin timezone="UTC" send={sender().send} />);
    expect(screen.queryByRole("button", { name: "Arm" })).toBeNull();
    expect(screen.getByText("This driver is deactivated. Reactivate them before arming.")).toBeTruthy();
    cleanup();
    const armedLeaving = { ...leaving, armed: { on: true, since: "2026-10-05T14:00:00.000Z" } };
    render(<DriverMoneyPanel identity={armedLeaving} canAdmin timezone="UTC" send={sender().send} />);
    expect(button("Disarm")).toBeTruthy();
    expect(screen.queryByText("This driver is deactivated. Reactivate them before arming.")).toBeNull();
  });

  it("shows an arm refused for a departed driver as its fixed sentence", async () => {
    render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={sender({ ok: false, error: "driver_inactive" }).send} />);
    fireEvent.click(button("Arm"));
    fireEvent.click(button("Arm"));
    await waitFor(() => expect(screen.getByText("This driver is deactivated. Reactivate them before arming.")).toBeTruthy());
  });

  it("gives staff the status but no status buttons, and says who can", () => {
    render(<DriverMoneyPanel identity={identity} canAdmin={false} timezone="UTC" send={sender().send} statusAdminOn today="2026-11-01" />);
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Only an admin deactivates or reactivates a driver.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("shows a status refusal as its own fixed sentence", async () => {
    render(
      <DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={sender({ ok: false, error: "bad_request" }).send} statusAdminOn today="2026-11-01" />,
    );
    fireEvent.click(button("Deactivate"));
    fireEvent.click(button("Deactivate"));
    await waitFor(() =>
      expect(screen.getByText("Pick a last day on or after the driver's start date and within a year of today.")).toBeTruthy(),
    );
  });

  describe("before arming", () => {
    const checklist: ActivationChecklist = {
      card: { id: DEFAULT_CARD, last4: "4417" },
      steps: { identity_confirmed: true, zero_test_sent: false, hand_load_acknowledged: false },
      identity: "match",
      openHandLoads: 0,
      blockers: ["activate_without_zero_test", "activate_after_hand_load"],
    };
    const rowOf = (label: string) => screen.getByText(label).closest("li") as HTMLElement;

    it("shows nothing new while the checklist is off", () => {
      render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={sender().send} />);
      expect(screen.queryByText("Before arming")).toBeNull();
      expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
    });

    it("words each step Done or Not done, with Record only on a step not done", () => {
      render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={sender().send} activation={checklist} />);
      expect(screen.getByText("Before arming")).toBeTruthy();
      expect(rowOf("Identity confirmed").textContent).toBe("Identity confirmedDone");
      expect(rowOf("Zero test sent").textContent).toBe("Zero test sentNot doneRecord");
      expect(rowOf("Hand loads acknowledged").textContent).toBe("Hand loads acknowledgedNot doneRecord");
    });

    it("records a step through its route, then says so and lets the page read again", async () => {
      const { send, calls } = sender();
      const onDone = vi.fn();
      render(<DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={send} onDone={onDone} activation={checklist} />);
      fireEvent.click(screen.getAllByRole("button", { name: "Record" })[0]);
      await waitFor(() => expect(screen.getByText("Recorded: zero test sent.")).toBeTruthy());
      expect(calls).toEqual([{ path: `/api/drivers/${DRIVER}/activation-steps`, body: { step: "zero_test_sent" } }]);
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it("shows a refused step and a refused arm as their fixed sentences", async () => {
      render(
        <DriverMoneyPanel identity={identity} canAdmin timezone="UTC" send={sender({ ok: false, error: "hand_load_open" }).send} activation={checklist} />,
      );
      fireEvent.click(screen.getAllByRole("button", { name: "Record" })[1]);
      await waitFor(() => expect(screen.getByText("A load on this driver's card still waits for a ruling.")).toBeTruthy());
      cleanup();
      render(
        <DriverMoneyPanel
          identity={identity}
          canAdmin
          timezone="UTC"
          send={sender({ ok: false, error: "activate_without_zero_test" }).send}
          activation={checklist}
        />,
      );
      fireEvent.click(button("Arm"));
      fireEvent.click(button("Arm"));
      await waitFor(() =>
        expect(screen.getByText("Send the zero-dollar test to the card and record it before arming.")).toBeTruthy(),
      );
    });

    it("shows staff the steps but no Record button", () => {
      render(<DriverMoneyPanel identity={identity} canAdmin={false} timezone="UTC" send={sender().send} activation={checklist} />);
      expect(rowOf("Zero test sent").textContent).toBe("Zero test sentNot done");
      expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
    });
  });
});
