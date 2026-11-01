import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import type { AiResult } from "../../../ai";
import { readAdvanceInput } from "../../../data/read";
import { advanceEligibility } from "../../../rules-engine";
import { instantAt } from "../../../seed/calendar";
import { addDays } from "../../../time/local-date";
import { callTool } from "../index";
import type { CompleteFn, GatewayContext } from "../types";
import { context, fixedClock, OTHER_ID, type Handler } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// The two advance read tools on the real readers and the real rules engine over the synthetic
// seed plan: the identity map shows last four digits and portal names, never a card's token, and
// the headroom tool gives the engine's own numbers without proposing anything.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const today = addDays(plan.anchor, -2);
const ctx: GatewayContext = context({ now: new Date(instantAt(today, 12, 0, zone)), timeZone: zone });
const hero = plan.rows.drivers.find((d) => d.code === plan.carrier.heroCode)!;
const heroLoad = plan.rows.loads.find((l) => l.driver_id === hero.id && l.delivered_on !== null)!;
const otherLoad = plan.rows.loads.find((l) => l.driver_id !== hero.id)!;

const screenStore: Handler = (sql) => {
  if (sql.startsWith("SELECT verdict, CAST(categories AS text)")) return [];
  if (sql.startsWith("INSERT INTO screenings")) return 1;
  return undefined;
};
const complete: CompleteFn = async () =>
  ({
    callId: "c0ffee00-0000-4000-8000-000000000004",
    status: "ok",
    text: "VERDICT: clean\nCATEGORIES: none\nCONFIDENCE: 0.99",
    toolCalls: [],
    usage: { input: 1, cached: 0, output: 1, reasoning: 0 },
    costNanocents: 1,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  }) satisfies AiResult;

const call = (name: string, args: unknown) => ({ id: "call-1", name, argumentsJson: JSON.stringify(args) });
const run = (name: string, args: unknown, role: GatewayContext["role"] = "operator") => {
  const db = planDb(plan, screenStore);
  return callTool({ ...ctx, role }, call(name, args), { db, clock: fixedClock, complete }).then((out) => ({ out, db }));
};

async function engine(amountCents: number, loadId?: string) {
  return planDb(plan).withTenant(ctx.session.tenantId, async (q) =>
    advanceEligibility(await readAdvanceInput(q, hero.id, ctx.now.toISOString(), amountCents, loadId)),
  );
}

describe("get_driver_identity", () => {
  it("gives the armed flag, the dispatch ids and every card by its last four, never a token", async () => {
    const { out } = await run("get_driver_identity", { driverId: hero.id }, "auditor");
    expect(out).toMatchObject({ decision: "allowed" });
    const driver = (out.result as { driver: Record<string, unknown> }).driver;
    expect(driver).toMatchObject({ id: hero.id, code: hero.code, armed: hero.money_armed });
    const ids = plan.rows.driver_identities.filter((i) => i.driver_id === hero.id).map((i) => i.external_id);
    expect(driver.tmsIds).toEqual([...ids].sort());
    const cards = plan.rows.driver_cards.filter((c) => c.driver_id === hero.id);
    expect((driver.cards as { last4: string }[]).map((c) => c.last4).sort()).toEqual(cards.map((c) => c.last4).sort());
    const text = JSON.stringify(out.result);
    for (const c of cards) expect(text).not.toContain(c.provider_token);
    expect(text).not.toMatch(/provider_token|providerToken/);
  });

  it("refuses a driver that is not on file before running", async () => {
    const { out } = await run("get_driver_identity", { driverId: OTHER_ID });
    expect(out).toMatchObject({ decision: "blocked" });
  });
});

describe("the activation checklist and the agent", () => {
  const saved = flags.activationChecklist.enabled;
  afterEach(() => {
    flags.activationChecklist.enabled = saved;
  });

  it("gives no checklist while the switch is off", async () => {
    flags.activationChecklist.enabled = false;
    const { out } = await run("get_driver_identity", { driverId: hero.id }, "auditor");
    expect(out).toMatchObject({ decision: "allowed" });
    expect((out.result as { activation: unknown }).activation).toBeNull();
  });

  it("has no tool that arms a driver or records a step: the checklist is read only", () => {
    const dir = join(__dirname, "..", "tools");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/advances\/arming|armDriver|recordActivationStep/);
    }
  });
});

describe("get_advance_headroom", () => {
  it("with no ask, gives the engine's most and its suggestion for that amount, and writes nothing", async () => {
    const first = await engine(1);
    const atMax = await engine(first.maxCents);
    const { out, db } = await run("get_advance_headroom", { driverId: hero.id });
    expect(out).toMatchObject({ decision: "allowed" });
    expect(out.result).toMatchObject({
      armed: hero.money_armed,
      maxCents: atMax.maxCents,
      suggestedCents: atMax.suggestedCents,
      feeCents: atMax.feeCents,
      loadCapCents: null,
    });
    expect(out.result).not.toHaveProperty("eligible");
    const writes = db.statements.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s.sql));
    expect(writes.every((s) => s.sql.startsWith("INSERT INTO gateway_decisions") || s.sql.startsWith("INSERT INTO screenings"))).toBe(true);
  });

  it("with the driver's own load, gives the load's cap, what is open and what is left", async () => {
    const d = await engine(100, heroLoad.id);
    const { out } = await run("get_advance_headroom", { driverId: hero.id, loadId: heroLoad.id, amountCents: 100 });
    expect(out.result).toMatchObject({
      loadCapCents: d.loadCapCents,
      openOnLoadCents: d.openOnLoadCents,
      loadHeadroomCents: d.loadHeadroomCents,
      eligible: d.eligible,
    });
    expect(d.loadCapCents).not.toBeNull();
  });

  it("says a load that is not the driver's has nothing to size against", async () => {
    const { out } = await run("get_advance_headroom", { driverId: hero.id, loadId: otherLoad.id });
    expect(out).toMatchObject({ decision: "allowed", result: { loadIsDrivers: false } });
  });

  it("refuses an ask that is not whole positive cents", async () => {
    for (const amountCents of [0, -5, 1.5, 2_000_000]) {
      const { out } = await run("get_advance_headroom", { driverId: hero.id, amountCents });
      expect(out).toMatchObject({ decision: "invalid_args" });
    }
  });
});
