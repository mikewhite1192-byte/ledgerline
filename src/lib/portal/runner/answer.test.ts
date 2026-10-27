import { describe, expect, it } from "vitest";
import { minutesAtDock, readAnswer, readbackOf, type PortalRecord } from "./answer";

const REF = "FFE-100001";
const BASE = {
  found: true,
  reference: REF,
  deliveryCheckedIn: "2026-10-20 09:05",
  deliveryCheckedOut: "2026-10-20 11:10",
  timeZoneLabel: "CT",
  podDownloaded: true,
  podSignedBy: "Dana Reyes",
  notes: "",
};
const text = (extra: Record<string, unknown> = {}) => JSON.stringify({ ...BASE, ...extra });

describe("readAnswer", () => {
  it("turns the wall times and the zone label into instants, by code", () => {
    expect(readAnswer(text(), REF)).toEqual({
      ok: true,
      answer: BASE,
      checkedIn: "2026-10-20T14:05:00.000Z",
      checkedOut: "2026-10-20T16:10:00.000Z",
      zone: "America/Chicago",
    });
  });

  it("tolerates one code fence around the object", () => {
    expect(readAnswer("```json\n" + text() + "\n```", REF).ok).toBe(true);
  });

  it("accepts an answer with no times at all", () => {
    expect(readAnswer(text({ deliveryCheckedIn: null, deliveryCheckedOut: null, timeZoneLabel: null }), REF)).toMatchObject({
      ok: true,
      checkedIn: null,
      zone: null,
    });
  });

  it.each([
    ["another reference", text({ reference: "FFE-100002" })],
    ["a reference that only contains the run's", text({ reference: `${REF}9` })],
    ["one time without the other", text({ deliveryCheckedOut: null })],
    ["times without a zone", text({ timeZoneLabel: null })],
    ["times on a load not found", text({ found: false })],
    ["check-out before check-in", text({ deliveryCheckedOut: "2026-10-20 08:00" })],
    ["a zone the portal never prints", text({ timeZoneLabel: "UTC" })],
    ["a time with seconds", text({ deliveryCheckedIn: "2026-10-20 09:05:00" })],
    ["an hour skipped by daylight saving", text({ deliveryCheckedIn: "2026-03-08 02:30", deliveryCheckedOut: "2026-03-08 04:00" })],
    ["an hour repeated by daylight saving", text({ deliveryCheckedIn: "2026-11-01 01:30", deliveryCheckedOut: "2026-11-01 04:00" })],
    ["an extra field", text({ podUrl: "https://example.test/pod.pdf" })],
    ["notes over 300 characters", text({ notes: "x".repeat(301) })],
    ["text around the object", `Here you go: ${text()}`],
    ["an empty answer", ""],
  ])("refuses %s", (_name, answer) => {
    expect(readAnswer(answer, REF)).toEqual({ ok: false });
  });
});

describe("readbackOf", () => {
  const record: PortalRecord = {
    checkedIn: "2026-10-20T14:05:00.000Z",
    checkedOut: "2026-10-20T16:10:00.000Z",
    zone: "America/Chicago",
    podContentHash: "abc",
  };
  const read = { checkedIn: record.checkedIn, checkedOut: record.checkedOut, zone: "America/Chicago" as const, podHash: "abc" };

  it("matches when every fact the portal holds was read back the same", () => {
    expect(readbackOf(read, record)).toBe("matches");
  });
  it("differs on a time, the zone, the POD bytes, or a claim the portal does not hold", () => {
    expect(readbackOf({ ...read, checkedOut: "2026-10-20T16:50:00.000Z" }, record)).toBe("differs");
    expect(readbackOf({ ...read, zone: "America/Denver" }, record)).toBe("differs");
    expect(readbackOf({ ...read, podHash: "xyz" }, record)).toBe("differs");
    expect(readbackOf(read, { ...record, checkedIn: null, checkedOut: null })).toBe("differs");
    expect(readbackOf(read, { ...record, podContentHash: null })).toBe("differs");
  });
  it("is partial when nothing disagrees but something was not read back", () => {
    expect(readbackOf({ ...read, podHash: null }, record)).toBe("partial");
    expect(readbackOf({ ...read, checkedIn: null, checkedOut: null, zone: null }, record)).toBe("partial");
  });
});

describe("minutesAtDock", () => {
  it("counts whole minutes, and nothing without both times", () => {
    expect(minutesAtDock("2026-10-20T14:05:00.000Z", "2026-10-20T16:10:00.000Z")).toBe(125);
    expect(minutesAtDock(null, "2026-10-20T16:10:00.000Z")).toBeNull();
  });
});
