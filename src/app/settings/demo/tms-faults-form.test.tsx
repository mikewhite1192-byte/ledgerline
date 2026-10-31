// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_FAULTS, NO_FAULTS } from "@/lib/adapters/tms-source/faults";
import { TMS_FAULT_MESSAGES, TmsFaultsForm } from "./tms-faults-form";

// The fault switches form with the network a stand-in (fetch), so the real post helper runs: a
// flip posts one fault, a success shows the faults the server replied with, a refusal shows its
// category's fixed message, and a lost reply says the change did not confirm. No server text is
// ever shown.

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const box = (fault: (typeof DEMO_FAULTS)[number]) => {
  const found = screen.getAllByRole("checkbox").find((el) => el.getAttribute("name") === fault);
  if (!found) throw new Error(`no switch ${fault}`);
  return found;
};

describe("the dispatch fault switches form", () => {
  it("shows all nine switches off for a clean carrier", () => {
    render(<TmsFaultsForm initial={NO_FAULTS} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(9);
    for (const f of DEMO_FAULTS) expect((box(f) as HTMLInputElement).checked).toBe(false);
  });

  it("posts the one flipped fault and shows the faults the server replied with", async () => {
    fetchMock.mockResolvedValue(reply(200, { faults: { ...NO_FAULTS, hard_delete: true, clock_skew: true } }));
    render(<TmsFaultsForm initial={NO_FAULTS} />);
    fireEvent.click(box("hard_delete"));
    await waitFor(() => expect((box("hard_delete") as HTMLInputElement).checked).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/demo/tms-faults");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ hard_delete: true });
    // The reply's own state wins, so a switch changed elsewhere shows too.
    expect((box("clock_skew") as HTMLInputElement).checked).toBe(true);
    expect((box("custom_status") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("posts an off flip as false", async () => {
    fetchMock.mockResolvedValue(reply(200, { faults: NO_FAULTS }));
    render(<TmsFaultsForm initial={{ ...NO_FAULTS, server_errors: true }} />);
    fireEvent.click(box("server_errors"));
    await waitFor(() => expect((box("server_errors") as HTMLInputElement).checked).toBe(false));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ server_errors: false });
  });

  it.each(["not_found", "role", "bad_request", "forbidden"])("shows only the fixed message for a %s refusal and keeps the switch as it was", async (category) => {
    fetchMock.mockResolvedValue(reply(category === "not_found" ? 404 : category === "bad_request" ? 400 : 403, { error: category, detail: "raw upstream text" }));
    render(<TmsFaultsForm initial={NO_FAULTS} />);
    fireEvent.click(box("hard_delete"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(TMS_FAULT_MESSAGES[category]);
    expect(alert.textContent).not.toContain("raw upstream text");
    expect((box("hard_delete") as HTMLInputElement).checked).toBe(false);
  });

  it("says the change did not confirm when the reply is lost", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    render(<TmsFaultsForm initial={NO_FAULTS} />);
    fireEvent.click(box("hard_delete"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(TMS_FAULT_MESSAGES.unknown);
    expect(alert.textContent).toContain("did not confirm");
    expect((box("hard_delete") as HTMLInputElement).checked).toBe(false);
  });

  it("says the change did not confirm after a server error with no category", async () => {
    fetchMock.mockResolvedValue(new Response("<html>oops</html>", { status: 502 }));
    render(<TmsFaultsForm initial={NO_FAULTS} />);
    fireEvent.click(box("hard_delete"));
    expect((await screen.findByRole("alert")).textContent).toBe(TMS_FAULT_MESSAGES.unknown);
  });

  it("falls back to a generic message for a category it does not know", async () => {
    fetchMock.mockResolvedValue(reply(409, { error: "something_new" }));
    render(<TmsFaultsForm initial={NO_FAULTS} />);
    fireEvent.click(box("hard_delete"));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save the change. Try again in a moment.");
  });
});
