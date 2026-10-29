import { describe, expect, it } from "vitest";
import type { TurnEvent } from "../view";
import { decodeEvents, encodeEvent } from "./stream";

const STEP: TurnEvent = { event: "step", data: { id: "s1", seq: 1, kind: "tool", label: "Reading pay items", state: "running" } };
const DONE: TurnEvent = { event: "done", data: { turnId: "t1", status: "done" } };

describe("turn stream", () => {
  it("round-trips events, holding back a partial one until it completes", () => {
    const wire = encodeEvent(STEP) + encodeEvent(DONE);
    const cut = wire.length - 5;
    const first = decodeEvents(wire.slice(0, cut));
    expect(first.events).toEqual([STEP]);
    const second = decodeEvents(first.rest + wire.slice(cut));
    expect(second.events).toEqual([DONE]);
    expect(second.rest).toBe("");
  });

  it("skips an event it cannot read", () => {
    const out = decodeEvents("event: step\ndata: {not json\n\n" + encodeEvent(DONE));
    expect(out.events).toEqual([DONE]);
  });

  it("passes the answer's checklist through, read back through its schema", () => {
    const list: TurnEvent = {
      event: "checklist",
      data: { v: 1, by: "model", items: [{ key: "m1", text: "Read Rosa's week", state: "doing" }] },
    };
    expect(decodeEvents(encodeEvent(list) + encodeEvent(DONE)).events).toEqual([list, DONE]);
    // A list that is not one is skipped, never shown half-read.
    const bad = 'event: checklist\ndata: {"v":1,"by":"model","items":[{"key":"m1","text":"x","state":"maybe"}]}\n\n';
    expect(decodeEvents(bad + encodeEvent(DONE)).events).toEqual([DONE]);
  });

  it("skips an event name it does not know", () => {
    expect(decodeEvents("event: other\ndata: {}\n\n" + encodeEvent(DONE)).events).toEqual([DONE]);
  });
});
