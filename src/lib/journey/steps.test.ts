import { describe, expect, it } from "vitest";
import { formatInstant } from "../format/dates";
import {
  boardRowOf,
  currentStep,
  journeyEvents,
  journeyStepsOf,
  onTheRoad,
  sortBoard,
  STEP_KEYS,
  stillMoving,
  type JourneyStep,
} from "./steps";
import { atAdvanceCard, emptyChain, failedPayout, fullChain, LOAD_ID, OPTS, ZONE } from "./test-fixtures";

const byKey = (steps: readonly JourneyStep[]) => Object.fromEntries(steps.map((s) => [s.key, s]));

describe("journeyStepsOf", () => {
  it("walks the whole road: eight steps done, each from its stored row", () => {
    const steps = journeyStepsOf(fullChain(), OPTS);
    expect(steps.map((s) => s.key)).toEqual([...STEP_KEYS]);
    expect(steps.map((s) => s.state)).toEqual(Array(8).fill("done"));
    const s = byKey(steps);
    expect(s.bol.fact).toBe("Muse Spark read the bill of lading, and code matched it to load L-20417.");
    expect(s.bol.actor).toBe("Driver");
    expect(s.bol.document?.id).toBe(fullChain().moves[0].document?.id);
    expect(s.bol.time).toBe(formatInstant("2026-11-02T15:05:00.000Z", ZONE));
    expect(s.advance_drafted.figureCents).toBe(15_000);
    expect(s.advance_drafted.fact).toBe("Drafted an advance card for fuel at pickup. Audit passed.");
    expect(s.advance_paid).toMatchObject({ figureCents: 15_000, tag: "Fuel card load", fact: "Approved by Admin, paid to the driver." });
    expect(s.advance_books).toMatchObject({ fact: "In QuickBooks, record ending 4215.", tag: "QuickBooks sandbox" });
    expect(s.pod.fact).toBe("Muse Spark read the proof of delivery, and code matched it to load L-20417.");
    expect(s.paystub_drafted.figureCents).toBe(209_500);
    expect(s.paystub_drafted.paystub?.lines.map((l) => [l.seq, l.thisLoad, l.note])).toEqual([
      [1, true, null],
      [2, false, null],
      [3, false, "5 days at $11.00 a day"],
      [4, false, null],
    ]);
    expect(s.paystub_drafted.paystub).toMatchObject({ grossCents: 240_000, deductionsCents: 30_500, netCents: 209_500 });
    expect(s.paystub_paid).toMatchObject({ figureCents: 209_500, tag: "Bank transfer" });
    expect(s.paystub_books.fact).toBe("In QuickBooks, records ending 4215 and 4223.");
    expect(stillMoving(steps)).toBe(false);
    expect(currentStep(steps)).toBeNull();
  });

  it("shows the whole road before anything happened: the first step now, the rest still to come", () => {
    const steps = journeyStepsOf(emptyChain(), OPTS);
    expect(steps.map((s) => s.state)).toEqual(["now", ...Array(7).fill("waiting")]);
    expect(steps[0].fact).toBe("Waiting for the driver's bill of lading");
    expect(steps.every((s) => s.figureCents === null && s.time === null && s.document === null)).toBe(true);
    expect(stillMoving(steps)).toBe(true);
    expect(currentStep(steps)?.key).toBe("bol");
  });

  it("stops at the advance card while it waits for a person", () => {
    const steps = journeyStepsOf(atAdvanceCard(), OPTS);
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "now", "waiting", "waiting", "waiting", "waiting", "waiting"]);
    const s = byKey(steps);
    expect(s.advance_drafted).toMatchObject({ figureCents: 15_000, tag: "Autopilot: asks a person", actor: "LedgerLine" });
    expect(s.advance_paid.fact).toBe("Waiting for a person to approve");
    expect(s.pod.fact).toBe("Waiting for the driver's proof of delivery");
    expect(currentStep(steps)?.key).toBe("advance_paid");
  });

  it("reads the audit and the autopilot before the person", () => {
    const f = atAdvanceCard();
    f.card = { ...f.card!, auditVerdict: null, autopilotMode: null };
    expect(byKey(journeyStepsOf(f, OPTS)).advance_paid.fact).toBe("Waiting for the audit");
    f.card = { ...f.card, auditVerdict: "pass" };
    expect(byKey(journeyStepsOf(f, OPTS)).advance_paid.fact).toBe("Waiting for the autopilot to look");
  });

  it("marks a failed payout stopped and moves the road on to delivery", () => {
    const steps = journeyStepsOf(failedPayout(), OPTS);
    const s = byKey(steps);
    expect(s.advance_paid).toMatchObject({ state: "stopped", fact: "The payout did not go through." });
    expect(s.advance_books).toMatchObject({ state: "skipped", fact: "No advance to record." });
    expect(s.pod.state).toBe("now");
    expect(currentStep(steps)?.key).toBe("advance_paid");
  });

  it("skips the advance when LedgerLine drafted none, in plain words", () => {
    const f = atAdvanceCard();
    f.card = null;
    f.moves = [{ ...f.moves[0], desk: { kind: "done", category: "daily_cap", at: "2026-11-02T15:06:00.000Z" } }];
    const s = byKey(journeyStepsOf(f, OPTS));
    expect(s.advance_drafted).toMatchObject({ state: "skipped", fact: "No advance: today's advance limit was reached." });
    expect(s.advance_paid.state).toBe("skipped");
    expect(s.pod.state).toBe("now");
  });

  it("says a stored read that matched another record without claiming this load", () => {
    const f = atAdvanceCard();
    const doc = f.moves[0].document!;
    f.moves = [{ ...f.moves[0], document: { ...doc, match: { found: false, reason: "no_record" } } }];
    expect(byKey(journeyStepsOf(f, OPTS)).bol.fact).toBe("Muse Spark read the bill of lading.");
  });

  it("does not post a paystub's books when the books step is off", () => {
    const f = fullChain();
    f.settlement = { ...f.settlement!, legs: f.settlement!.legs.filter((l) => l.kind === "settlement_payout") };
    const s = byKey(journeyStepsOf(f, { ...OPTS, books: { ...OPTS.books, enabled: false } }));
    expect(s.paystub_books).toMatchObject({ state: "skipped", fact: "Not in QuickBooks yet." });
  });
});

describe("the On the road board", () => {
  const due = "2026-11-03T22:00:00.000Z";

  it("builds a row from what happened: driver, truck, route, due time and the step it stands at", () => {
    const f = atAdvanceCard();
    const steps = journeyStepsOf(f, OPTS);
    const row = boardRowOf(f, steps, { zone: ZONE, now: Date.parse("2026-11-02T18:00:00.000Z") });
    expect(row).toMatchObject({
      loadId: LOAD_ID,
      number: "L-20417",
      driver: "Rosa Delgado",
      truck: "T-118",
      route: "Joliet, IL to Memphis, TN",
      due: `Due ${formatInstant(due, ZONE)}`,
      late: false,
      where: `Picked up in Joliet, IL at ${formatInstant("2026-11-02T15:05:00.000Z", ZONE)}`,
      stepTitle: "Advance paid",
      stepState: "now",
      href: `/records/loads/${LOAD_ID}/journey`,
    });
    expect(Date.parse(row.dueAt!)).toBe(Date.parse(due));
    expect(row.steps).toEqual(steps.map((s) => s.state));
  });

  it("reads late past the delivery window, and delivered once delivered", () => {
    const f = atAdvanceCard();
    const late = boardRowOf(f, journeyStepsOf(f, OPTS), { zone: ZONE, now: Date.parse("2026-11-04T01:00:00.000Z") });
    expect(late).toMatchObject({ late: true, due: `Late: due ${formatInstant(due, ZONE)}` });
    const done = fullChain();
    const row = boardRowOf(done, journeyStepsOf(done, OPTS), { zone: ZONE, now: Date.parse("2026-11-09T00:00:00.000Z") });
    const at = formatInstant("2026-11-03T20:40:00.000Z", ZONE);
    expect(row).toMatchObject({ late: false, due: `Delivered ${at}`, where: `Delivered in Memphis, TN at ${at}`, stepState: "finished" });
  });

  it("never invents a window or a place: no window on file reads none, a planned load waits at pickup", () => {
    const f = emptyChain();
    f.dispatch = { truck: null, dueLocal: null };
    const row = boardRowOf(f, journeyStepsOf(f, OPTS), { zone: ZONE, now: 0 });
    expect(row).toMatchObject({ due: null, dueAt: null, truck: null, where: "Waiting for pickup in Joliet, IL", stepState: "now" });
  });

  it("sorts soonest delivery first, loads with no window last, then by number", () => {
    const mk = (number: string, dueAt: string | null) => ({ ...boardRowOf(emptyChain(), [], { zone: ZONE, now: 0 }), number, dueAt });
    const rows = sortBoard([mk("L-3", null), mk("L-2", "2026-11-05T12:00:00.000Z"), mk("L-1", null), mk("L-4", "2026-11-04T12:00:00.000Z")]);
    expect(rows.map((r) => r.number)).toEqual(["L-4", "L-2", "L-1", "L-3"]);
  });

  it("keeps a load on the board until its paystub is paid and recorded", () => {
    const full = fullChain();
    expect(onTheRoad(full, journeyStepsOf(full, OPTS))).toBe(false);
    const planned = emptyChain();
    expect(onTheRoad(planned, journeyStepsOf(planned, OPTS))).toBe(true);
    const noDriver = { ...planned, load: { ...planned.load, driverId: null } };
    expect(onTheRoad(noDriver, journeyStepsOf(noDriver, OPTS))).toBe(false);
    const cancelled = { ...planned, load: { ...planned.load, status: "cancelled" as const } };
    expect(onTheRoad(cancelled, journeyStepsOf(cancelled, OPTS))).toBe(false);
    const moving = atAdvanceCard();
    expect(onTheRoad(moving, journeyStepsOf(moving, OPTS))).toBe(true);
  });

  it("streams the newest done steps across loads, newest first, capped", () => {
    const full = fullChain();
    const lines = journeyEvents([{ facts: full, steps: journeyStepsOf(full, OPTS) }], ZONE);
    expect(lines).toHaveLength(8);
    expect(lines[0].key).toBe(`${LOAD_ID}:paystub_books`);
    expect(lines.at(-1)?.key).toBe(`${LOAD_ID}:bol`);
    expect(lines.find((l) => l.key.endsWith(":advance_paid"))?.words).toBe("Load L-20417: Advance paid, $150.00");
    expect(lines.every((l) => l.href === `/records/loads/${LOAD_ID}/journey`)).toBe(true);
    expect(journeyEvents([{ facts: full, steps: journeyStepsOf(full, OPTS) }], ZONE, 3)).toHaveLength(3);
    const empty = emptyChain();
    expect(journeyEvents([{ facts: empty, steps: journeyStepsOf(empty, OPTS) }], ZONE)).toEqual([]);
  });
});
