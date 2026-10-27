// Invented names and numbers for the design review only. Nothing here comes from the seed, a
// database or any real carrier, so /design renders the same for anyone, signed in or not.
import type { ProposalCardProps } from "@/components/app/proposal-card";
import type { DriverIdentity } from "@/lib/advances/identity";
import type { PaystubProps } from "@/components/app/paystub";
import { formatCents } from "@/lib/format/money";
import type { SourceRef } from "@/lib/records/href";

export const SAMPLE_TENANT = {
  name: "Sample Freight Co",
  email: "ops@samplefreight.example",
  timezone: "America/Chicago",
};

export const DRIVER = { name: "Dana Whitfield", code: "SF-D07", workerType: "company" as const };

// The sample driver's fuel card, by its last four only (a made-up number).
export const FUEL_CARD_LAST4 = "4417";
export const PERIOD = { start: "2026-10-26", end: "2026-11-01" };

// The sample driver's money panel: armed, one dispatch id, a default card in their name, a pool
// card with its portal placeholder, and an old closed card. Made-up ids and numbers.
export const MONEY_IDENTITY: DriverIdentity = {
  driverId: "00000000-0000-4000-8000-0000000000d7",
  code: DRIVER.code,
  name: DRIVER.name,
  activeTo: null,
  armed: { on: true, since: "2026-10-05T13:00:00.000Z" },
  tmsIds: ["TMS-40217"],
  cards: [
    { id: "00000000-0000-4000-8000-0000000000c1", last4: FUEL_CARD_LAST4, status: "active", isDefault: true, holderKind: "named", portalName: null, testMode: true },
    { id: "00000000-0000-4000-8000-0000000000c2", last4: "0932", status: "active", isDefault: false, holderKind: "generic", portalName: "POOL CARD 3", testMode: true },
    { id: "00000000-0000-4000-8000-0000000000c3", last4: "7710", status: "closed", isDefault: false, holderKind: "named", portalName: null, testMode: true },
  ],
};

export const MONEY_IDENTITY_NOT_ARMED: DriverIdentity = {
  ...MONEY_IDENTITY,
  armed: { on: false, since: null },
  tmsIds: [],
  cards: [],
};

const ref = (table: string, id: string): SourceRef => ({ table, id });

export const SOURCES = {
  driver: ref("drivers", "SF-D07"),
  load1: ref("loads", "L-10421"),
  load2: ref("loads", "L-10422"),
  load3: ref("loads", "L-10423"),
  load4: ref("loads", "L-10424"),
  lumper: ref("pay_items", "PI-0912"),
  insurance: ref("deduction_schedules", "DS-INS-07"),
  escrow: ref("deduction_schedules", "DS-ESC-07"),
  advance: ref("advances", "ADV-3301"),
  payRules: ref("pay_configs", "PC-SF-D07"),
  fuel: ref("fuel_purchases", "FP-7781"),
  customer: ref("customers", "C-HARTWELL"),
  invoiceA: ref("invoices", "INV-20417"),
  invoiceB: ref("invoices", "INV-20418"),
};

// Every record a link on this page points at, with what it is. The table at the bottom of the
// page carries these, so each link lands on its row.
export const SOURCE_ROWS: { ref: SourceRef; what: string }[] = [
  { ref: SOURCES.driver, what: "Dana Whitfield, company driver" },
  { ref: SOURCES.load1, what: "Hartwell Produce, Fresno CA to Denver CO, 1,250 loaded miles, delivered Oct 26" },
  { ref: SOURCES.load2, what: "Hartwell Produce, Denver CO to Chicago IL, 1,000 loaded miles, delivered Oct 28" },
  { ref: SOURCES.load3, what: "Hartwell Produce, Chicago IL to Phoenix AZ, 1,750 loaded miles, delivered Oct 31" },
  { ref: SOURCES.load4, what: "Hartwell Produce, a local run in the Phoenix AZ area, 70 loaded miles, delivered Nov 4" },
  { ref: SOURCES.lumper, what: "Lumper and scale fees paid by the driver, receipts attached" },
  { ref: SOURCES.insurance, what: "Occupational accident insurance, $11.00 a day worked" },
  { ref: SOURCES.escrow, what: "Escrow, $100.00 a week until $2,500.00 is held" },
  { ref: SOURCES.advance, what: "Advance of $200.00 paid Oct 28, repaid from this paystub" },
  { ref: SOURCES.payRules, what: "Company driver, $0.60 a loaded mile, advances up to $500.00" },
  { ref: SOURCES.fuel, what: "Fuel in Indiana on Oct 29, 96.4 gallons, no matching load" },
  { ref: SOURCES.customer, what: "Hartwell Produce, net 30" },
  { ref: SOURCES.invoiceA, what: "Invoice for L-10421, $3,200.00, sent Oct 26" },
  { ref: SOURCES.invoiceB, what: "Invoice for L-10422, $1,850.00, sent Oct 28" },
];

// The hero week: the totals are given, never recomputed by the paystub.
export const PAYSTUB: Omit<PaystubProps, "hrefFor"> = {
  driver: DRIVER,
  period: PERIOD,
  status: "draft",
  lines: [
    { seq: 1, kind: "load_pay", label: "Load pay, 3 loads", amountCents: 240_000, sources: [SOURCES.load1, SOURCES.load2, SOURCES.load3] },
    { seq: 2, kind: "reimbursement", label: "Reimbursements", amountCents: 18_000, sources: [SOURCES.lumper] },
    { seq: 3, kind: "insurance", label: "Insurance, 5 days", amountCents: -5_500, sources: [SOURCES.insurance] },
    { seq: 4, kind: "escrow", label: "Escrow", amountCents: -10_000, sources: [SOURCES.escrow] },
    { seq: 5, kind: "advance_recovery", label: "Advance taken Oct 28", amountCents: -20_000, sources: [SOURCES.advance] },
  ],
  grossCents: 258_000,
  deductionsCents: 35_500,
  netCents: 222_500,
  carryForwardCents: 0,
  exceptions: [
    {
      category: "unmatched_fuel",
      label: "A fuel purchase on Oct 29 has no matching load, so it is not deducted yet.",
      sources: [SOURCES.fuel],
    },
  ],
};

// A short week, as the rules engine settles one: insurance is taken in full, net pay stops at
// zero, and the shortfall is a positive add-back taken from next period's pay. The lines still
// add up: gross, less deductions, plus the carry, is the net.
export const SHORT_WEEK_PAYSTUB: Omit<PaystubProps, "hrefFor"> = {
  driver: DRIVER,
  period: { start: "2026-11-02", end: "2026-11-08" },
  status: "draft",
  lines: [
    { seq: 1, kind: "load_pay", label: "Load pay, 1 load", amountCents: 4_200, sources: [SOURCES.load4] },
    { seq: 2, kind: "insurance", label: "Insurance, 5 days", amountCents: -5_500, sources: [SOURCES.insurance] },
  ],
  grossCents: 4_200,
  deductionsCents: 5_500,
  netCents: 0,
  carryForwardCents: 1_300,
  exceptions: [
    {
      category: "net_below_zero",
      label: `Insurance came to more than this week's pay, so net pay is ${formatCents(0)}.`,
      sources: [SOURCES.driver],
    },
  ],
};

export const ADVANCE_PROPOSAL: Omit<ProposalCardProps, "hrefFor" | "status"> = {
  id: "proposal-advance",
  title: `Pay a ${formatCents(20_000)} advance to ${DRIVER.name}`,
  impact: { cents: 20_000, direction: "out" },
  reasons: [
    { text: `Earned and unpaid this week: ${formatCents(240_000)}`, source: SOURCES.load1 },
    { text: `Open advances: ${formatCents(0)}`, source: SOURCES.driver },
    { text: `Advance limit: ${formatCents(50_000)}; this request fits`, source: SOURCES.payRules },
  ],
  sources: [SOURCES.load2, SOURCES.load3],
  destination: { label: `To fuel card ···· ${FUEL_CARD_LAST4}`, testMode: true },
  confirmQuestion: `Pay ${formatCents(20_000)} to ${DRIVER.name}'s fuel card ···· ${FUEL_CARD_LAST4}? Test mode.`,
};

export const PAYMENT_PROPOSAL: Omit<ProposalCardProps, "hrefFor" | "status"> = {
  id: "proposal-payment",
  title: "Record Hartwell Produce's payment against invoice INV-20417",
  impact: { cents: 320_000, direction: "in", label: "Applies to INV-20417" },
  reasons: [
    { text: `Check for ${formatCents(320_000)} received Oct 30`, source: SOURCES.customer },
    { text: `Open balance on INV-20417: ${formatCents(320_000)}`, source: SOURCES.invoiceA },
  ],
};

export const MOVE_PROPOSAL: Omit<ProposalCardProps, "hrefFor" | "status"> = {
  id: "proposal-move",
  title: "Move a payment that landed on the wrong invoice",
  impact: { cents: 185_000, direction: "none", label: "Moves between invoices" },
  reasons: [
    { text: `${formatCents(185_000)} was applied to INV-20417 but matches INV-20418`, source: SOURCES.invoiceB },
  ],
};

export type LoadRow = {
  id: string;
  customer: string;
  lane: string;
  delivered: string;
  miles: number;
  status: string;
  payCents: number;
};

export const LOADS: LoadRow[] = [
  { id: "L-10421", customer: "Hartwell Produce", lane: "Fresno CA to Denver CO", delivered: "2026-10-26", miles: 1_250, status: "paid", payCents: 75_000 },
  { id: "L-10422", customer: "Hartwell Produce", lane: "Denver CO to Chicago IL", delivered: "2026-10-28", miles: 1_000, status: "invoiced", payCents: 60_000 },
  { id: "L-10423", customer: "Hartwell Produce", lane: "Chicago IL to Phoenix AZ", delivered: "2026-10-31", miles: 1_750, status: "delivered", payCents: 105_000 },
];

export const SUGGESTIONS = [
  { id: "paystub-problems", label: "Who has a problem on this week's paystub?" },
  { id: "past-60", label: "Who owes us money past 60 days?" },
  { id: "pay-run-cost", label: "What will Friday's pay run cost?" },
  { id: "advance-limit", label: "Who is over their advance limit?" },
];
