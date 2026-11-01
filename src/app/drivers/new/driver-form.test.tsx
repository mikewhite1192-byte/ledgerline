// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELD_SENTENCES, RATE_SENTENCES } from "@/lib/drivers/draft";
import { DriverForm, type DriverSend } from "./driver-form";

// The Add driver form: each wrong field gets its own sentence and nothing is sent; a good form
// sends whole cents and moves to the new driver's page; a code or email on file is shown on its
// field; anything not known to have failed says to look before trying again.

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  push.mockReset();
});

const NEW_ID = "55555555-5555-4555-8555-555555555555";

function fill(send: DriverSend) {
  render(<DriverForm today="2026-11-02" send={send} />);
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  type("Driver code", "br-d27");
  type("Email", "Ana@Example.test");
  type("First name", "Ana");
  type("Last name", "Example");
  type("Dollars per mile", "0.62");
}

const submit = () => fireEvent.click(screen.getByRole("button", { name: "Add driver" }));

describe("DriverForm", () => {
  it("shows a sentence on each wrong field and sends nothing", async () => {
    const send = vi.fn<DriverSend>();
    render(<DriverForm today="2026-11-02" send={send} />);
    fireEvent.change(screen.getByLabelText("Driver code"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Tank gallons"), { target: { value: "50" } });
    submit();
    expect(await screen.findByText(FIELD_SENTENCES.code)).toBeTruthy();
    expect(screen.getByText(FIELD_SENTENCES.email)).toBeTruthy();
    expect(screen.getByText(FIELD_SENTENCES.firstName)).toBeTruthy();
    expect(screen.getByText(FIELD_SENTENCES.tankGallons)).toBeTruthy();
    // The rate field's hint and its error are the same sentence for the chosen basis.
    expect(screen.getAllByText(RATE_SENTENCES.per_mile).length).toBeGreaterThan(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("asks for the rate the chosen basis names, and sends basis points for a percent", async () => {
    const send = vi.fn<DriverSend>().mockResolvedValue({ ok: true, id: NEW_ID });
    fill(send);
    fireEvent.change(screen.getByLabelText("Paid by"), { target: { value: "percent" } });
    expect(screen.queryByLabelText("Dollars per mile")).toBeNull();
    fireEvent.change(screen.getByLabelText("Percent of linehaul", { selector: "input" }), { target: { value: "72.5" } });
    submit();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toMatchObject({ payBasis: "percent", percentBps: 7_250 });
    expect(send.mock.calls[0][0]).not.toHaveProperty("perMileCents");
  });

  it("sends the driver in whole cents and opens their page", async () => {
    const send = vi.fn<DriverSend>().mockResolvedValue({ ok: true, id: NEW_ID });
    fill(send);
    fireEvent.change(screen.getByLabelText("Advance limit (optional)"), { target: { value: "500" } });
    submit();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/records/drivers/${NEW_ID}`));
    expect(send).toHaveBeenCalledWith({
      code: "BR-D27",
      firstName: "Ana",
      lastName: "Example",
      email: "ana@example.test",
      workerType: "company",
      payBasis: "per_mile",
      perMileCents: 62,
      advanceLimitCents: 50_000,
      tankGallons: 200,
      activeFrom: "2026-11-02",
      ownInsurance: false,
      preferredLanguage: "en",
    });
  });

  it("shows a code already on file on the code field with a link to find that driver", async () => {
    fill(vi.fn<DriverSend>().mockResolvedValue({ ok: false, error: "code_taken" }));
    submit();
    expect(await screen.findByText(/A driver with code BR-D27 already exists/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Find them" }).getAttribute("href")).toBe("/drivers?status=all&q=BR-D27");
    expect(push).not.toHaveBeenCalled();
  });

  it("shows an email on file on its field, a refusal by its sentence, and an unknown outcome as unknown", async () => {
    const send = vi.fn<DriverSend>().mockResolvedValueOnce({ ok: false, error: "email_taken" });
    fill(send);
    submit();
    expect(await screen.findByText("Another driver on file already uses this email.")).toBeTruthy();
    send.mockResolvedValueOnce({ ok: false, error: "role" });
    submit();
    expect(await screen.findByText("Only an admin adds a driver. Nothing was added.")).toBeTruthy();
    send.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    submit();
    expect(await screen.findByText(/may or may not have been saved/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});
