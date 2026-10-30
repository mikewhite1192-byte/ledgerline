// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RatesPage, RateView } from "@/lib/rates/read";
import { pinnedFromLine, RATES_WORDS as W } from "@/lib/rates/words";
import { RatesBoard } from "./rates-board";

// The rates board with the server a stand-in: one action at a time. A pin never starts while a
// lookup or another pin is out, so the one already out cannot clear the way for the same pin to
// be sent twice; once nothing is out, the pin goes as before.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const DIESEL_ID = "6b2e3d4c-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
const IL_ID = "7c3f4e5d-6a7b-4c8d-8e9f-1a2b3c4d5e6f";

const suggested = (over: Partial<RateView>): RateView => ({
  id: DIESEL_ID,
  kind: "diesel_index",
  state: null,
  status: "suggested",
  valueMcents: 371_200,
  perGallon: "$3.712",
  sourceUrl: "https://rates.example/diesel/weekly",
  sourceTitle: "Weekly diesel prices, all regions",
  sourceHost: "rates.example",
  quote: "Diesel averaged 3.712 dollars a gallon for the week of October 26, 2026.",
  asOf: "2026-10-26",
  effectiveFrom: null,
  pinnedAt: null,
  pinnedOn: null,
  byYou: true,
  typed: false,
  createdAt: "2026-10-27T15:00:00.000Z",
  ...over,
});

const PAGE: RatesPage = {
  today: "2026-10-27",
  canPin: true,
  lookupsLeft: 17,
  diesel: { pinned: null, suggestion: suggested({}) },
  states: [
    {
      code: "IL",
      name: "Illinois",
      pinned: null,
      suggestion: suggested({
        id: IL_ID,
        kind: "ifta_rate",
        state: "IL",
        valueMcents: 45_400,
        perGallon: "$0.4540",
        sourceUrl: "https://rates.example/fuel-tax/illinois",
        sourceTitle: "Illinois motor fuel tax",
        quote: "Illinois diesel 0.4540 per gallon.",
      }),
    },
  ],
};

function reply(status: number, body: unknown) {
  return new Response(new Uint8Array(Buffer.from(JSON.stringify(body))), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A server answer the test lets go of when it chooses.
function held(body: unknown) {
  let release = () => {};
  const answer = new Promise<Response>((resolve) => (release = () => resolve(reply(200, body))));
  return { answer, release };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => reply(200, { ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

const urls = () => fetchMock.mock.calls.map(([url]) => String(url));
// The one state row; the diesel price's own button comes first on the page.
const illinois = () => within(screen.getByRole("listitem"));
const dieselOpener = () => screen.getAllByRole("button", { name: W.pinThis })[0];
const stateOpener = () => illinois().getByRole("button", { name: W.pinThis });

// Opens a suggestion's confirm and returns its confirm button.
function openConfirm(opener: HTMLElement, perGallon: string): HTMLElement {
  fireEvent.click(opener);
  const panel = screen.getByRole("group", { name: `Pin ${perGallon} per gallon?` });
  return within(panel).getByRole("button", { name: W.pinThis });
}

describe("RatesBoard", () => {
  it("sends no pin while a lookup is out, and sends it once when the lookup is done", async () => {
    const lookup = held({ ok: true, status: "suggested", id: DIESEL_ID });
    fetchMock.mockReturnValueOnce(lookup.answer);
    render(<RatesBoard page={PAGE} />);
    fireEvent.click(screen.getByRole("button", { name: W.lookUpDiesel }));
    expect(urls()).toEqual(["/api/rates/lookup"]);

    const confirm = openConfirm(stateOpener(), "$0.4540");
    fireEvent.click(confirm);
    expect(urls()).toEqual(["/api/rates/lookup"]);

    lookup.release();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    fireEvent.click(illinois().getByRole("button", { name: W.pinThis }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(urls()).toEqual(["/api/rates/lookup", `/api/rates/${IL_ID}/pin`]);
  });

  it("sends no second pin while one is out, so each rate is sent once", async () => {
    const pin = held({ ok: true });
    fetchMock.mockReturnValueOnce(pin.answer);
    render(<RatesBoard page={PAGE} />);
    const dieselConfirm = openConfirm(dieselOpener(), "$3.712");
    const stateConfirm = openConfirm(stateOpener(), "$0.4540");
    fireEvent.click(dieselConfirm);
    fireEvent.click(stateConfirm);
    expect(urls()).toEqual([`/api/rates/${DIESEL_ID}/pin`]);

    pin.release();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    fireEvent.click(illinois().getByRole("button", { name: W.pinThis }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(urls()).toEqual([`/api/rates/${DIESEL_ID}/pin`, `/api/rates/${IL_ID}/pin`]);
  });

  it("says a pinned rate is recorded and that no rate rule uses it yet", () => {
    const pinned = suggested({
      status: "pinned",
      effectiveFrom: "2026-10-19",
      pinnedAt: "2026-10-20T14:00:00.000Z",
      pinnedOn: "2026-10-20",
    });
    render(<RatesBoard page={{ ...PAGE, diesel: { pinned, suggestion: null } }} />);
    expect(screen.getByText(pinnedFromLine("Oct 19, 2026"))).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/rate rules use/i);
  });
});
