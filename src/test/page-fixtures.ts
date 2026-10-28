import type { AdvanceListRow, AdvanceRecord, DriverAdvance, DriverOption } from "@/lib/advances/read";
import type { DriverIdentity } from "@/lib/advances/identity";
import { reasonSentence } from "@/lib/agent/reasons";
import type { ProposalView, TurnView } from "@/lib/agent/view";
import type { CallRow, Spend } from "@/lib/ai/spend";
import type { DaySpend, SpendAlert } from "@/lib/ai/watch";
import type { CashCheckView, CashHome, CashView, VendorBillView } from "@/lib/cash/view";
import type { ClipView } from "@/lib/clips/types";
import type { DocumentView } from "@/lib/documents/types";
import type { DriverView, NotePeriod, PeriodNotes } from "@/lib/driver-notes/view";
import { figureValueText, profitWeek, type ClosedWeek } from "@/lib/briefs/figures";
import type { BriefRecord, ProfitView } from "@/lib/briefs/view";
import { fuelSentence, type SentenceInput } from "@/lib/fuel/help";
import type { FuelPage, FuelRowView, FuelRunView } from "@/lib/fuel/view";
import type {
  CustomerRecordView,
  InvoiceListRow,
  InvoiceRecordView,
  LoadRecordView,
  PaymentFormCustomer,
  PaymentRecordView,
  QueueItemRow,
} from "@/lib/invoices/views";
import { REVIEW_REASON_LABELS, REVIEW_STATUS_LABELS, reviewReasonSentence } from "@/lib/invoices/labels";
import type { InvoiceReviewView, ReviewQueue } from "@/lib/invoices/review-read";
import type { PortalLoadDetail, PortalLoadLine } from "@/lib/portal/read";
import type { RunSummary, RunView } from "@/lib/portal/views";
import type { InvoiceReviewReason, InvoiceReviewStatus } from "@/lib/rules-engine";
import type { DriverDayView, PayItemView, ScheduleView } from "@/lib/records/views";
import type { Cents, PayLine } from "@/lib/rules-engine/types";
import { DEMO_ANCHOR } from "@/lib/seed/anchor";
import { DEMO_CARRIERS } from "@/lib/seed/carriers";
import { buildCarrierPlan } from "@/lib/seed/plan";
import type { MarginLine } from "@/lib/reports/margin-per-load";
import { RESET_TABLES, type DemoResetPreview } from "@/lib/seed/reset";
import { exceptionLabel, parkLabel } from "@/lib/settlements/labels";
import type {
  BatchRecordView,
  DriverRecordView,
  SettlementListRow,
  SettlementRecordView,
  SettlementsView,
} from "@/lib/settlements/views";
import type { FanoutTree } from "@/lib/sweep/fanout/tree";
import type { SweepCounts } from "@/lib/sweep/run";
import type { SweepHome, SweepItemView, SweepPage, SweepRunView } from "@/lib/sweep/view";
import { summarizeModelWeek, type ModelWeek } from "@/lib/trace/week";
import type { VoiceDetail, VoiceListRow } from "@/lib/voice/read";

// Synthetic rows for the banned-word test: every page rendered with something in it, so the words
// a person reads around real data are scanned, not only the empty states. Ids are made up; the
// dates are stored shapes (ISO), so a page that prints one raw fails the test.

export const TENANT = { name: "Blue Ridge Freight", timezone: "America/New_York" };
export const EMAIL = "office@example.test";

const id = (n: number) => `0b9f6a52-3c1d-4e8f-9a7b-${String(n).padStart(12, "0")}`;
export const ID = id(1);
const DRIVER_ID = id(2);
const CUSTOMER_ID = id(3);
const LOAD_ID = id(4);
const INVOICE_ID = id(5);
const PAYMENT_ID = id(6);
const PERIOD_ID = id(7);
const RUN_ID = id(8);
export const MEMBER_ID = id(9);

export const DRIVERS: DriverOption[] = [
  { id: DRIVER_ID, code: "BR-D07", name: "Rosa Delgado" },
  { id: id(21), code: "BR-D12", name: "Marcus Hale" },
];

const proposal = (over: Partial<ProposalView>): ProposalView => ({
  id: id(30),
  kind: "advance_payout",
  subjectTable: "drivers",
  subjectId: DRIVER_ID,
  subjectLabel: "BR-D07",
  amountCents: 25_000,
  direction: "out",
  title: "Fuel advance for Rosa Delgado",
  reasons: [{ category: "within_limit", text: "Within the driver's advance limit.", source: { table: "drivers", id: DRIVER_ID } }],
  sources: [
    { table: "drivers", id: DRIVER_ID },
    { table: "loads", id: LOAD_ID },
  ],
  status: "proposed",
  flagged: false,
  flagCategories: [],
  operatorVerdict: "allowed",
  auditorVerdict: "pass",
  auditorConcerns: [],
  auditorCheckedAt: "2026-10-28T15:04:00.000Z",
  auditorOverride: null,
  destination: { label: "fuel card", last4: "4417", testMode: true },
  ...over,
});

// One card per status, so every card footer and badge is read.
export const PROPOSALS: ProposalView[] = [
  proposal({}),
  proposal({ id: id(31), status: "approved", auditorVerdict: "concerns", auditorConcerns: ["amount_high"] }),
  proposal({ id: id(32), status: "executing" }),
  proposal({ id: id(33), status: "done" }),
  proposal({ id: id(34), status: "unknown" }),
  proposal({ id: id(35), status: "failed", auditorVerdict: null, auditorCheckedAt: null }),
  proposal({ id: id(36), status: "rejected", destination: null }),
  proposal({ id: id(37), status: "expired", destination: null }),
  proposal({
    id: id(38),
    status: "proposed",
    auditorVerdict: "block",
    auditorConcerns: ["evidence_missing"],
    auditorOverride: { reason: "Driver called the office", byLabel: "Admin", at: "2026-10-28T16:00:00.000Z" },
    flagged: true,
    flagCategories: ["instruction_like"],
  }),
];

export const INVOICE_PROPOSALS: ProposalView[] = [
  proposal({
    id: id(40),
    kind: "invoice_fix",
    subjectTable: "invoices",
    subjectId: INVOICE_ID,
    subjectLabel: "BR-INV-10244",
    amountCents: 182_500,
    direction: "in",
    title: "Invoice BR-INV-10244 is missing its detention charge",
    destination: null,
  }),
  proposal({
    id: id(41),
    kind: "invoice_post",
    subjectTable: "invoices",
    subjectId: INVOICE_ID,
    subjectLabel: "BR-INV-10244",
    amountCents: 182_500,
    direction: "none",
    title: "Post invoice BR-INV-10244 to QuickBooks",
    status: "failed",
    destination: null,
  }),
];

export const TURNS: TurnView[] = [
  {
    id: id(50),
    conversationId: id(51),
    seq: 1,
    userText: "Can Rosa get a $250 fuel advance?",
    status: "done",
    endedReason: null,
    text: "Rosa Delgado can take up to $400.00 now. I drafted a $250.00 advance for you to approve.",
    steps: [
      { id: id(52), seq: 1, kind: "model", label: "Planning", state: "done" },
      { id: id(53), seq: 2, kind: "tool", label: "Reading the pay ledger", state: "done" },
      { id: id(54), seq: 3, kind: "tool", label: "Reading the proposal and its evidence", state: "done" },
      { id: id(55), seq: 4, kind: "proposal", label: "Preparing a proposal card", state: "done" },
    ],
    proposals: [PROPOSALS[0]],
    flags: [],
    reports: [],
    error: null,
  },
  {
    id: id(56),
    conversationId: id(51),
    seq: 2,
    userText: "Who owes us the most?",
    status: "failed",
    endedReason: "job_cap",
    text: "",
    steps: [{ id: id(57), seq: 1, kind: "tool", label: "Aging the receivables", state: "failed" }],
    proposals: [],
    flags: [],
    reports: [],
    error: "job_cap",
  },
];

export const SPEND: Spend = {
  spentNanocents: 124_000_000_000,
  reservedNanocents: 2_000_000_000,
  calls: 42,
  wonderSpentNanocents: 45_000_000_000,
  wonderReservedNanocents: 0,
};

export const CALLS: CallRow[] = [
  {
    id: id(60),
    target: "spark",
    kind: "chat",
    purpose: "proof",
    model: "muse-spark-1.3",
    reasoning_effort: "low",
    status: "ok",
    failure: null,
    input_tokens: 120,
    output_tokens: 40,
    reasoning_tokens: null,
    units: null,
    cost_nanocents: 90_000_000,
    duration_ms: 1_200,
    upstream_id: "resp_7c41e2a9b3",
    created_utc: "2026-10-28 15:04:00",
  },
  {
    id: id(61),
    target: "spark_open",
    kind: "chat",
    purpose: "agent_operator_turn",
    model: "muse-spark-open",
    reasoning_effort: null,
    status: "reserved",
    failure: null,
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    units: null,
    cost_nanocents: null,
    duration_ms: null,
    upstream_id: null,
    created_utc: "2026-10-28 15:05:00",
  },
];

export const WEEK: ModelWeek = summarizeModelWeek({
  week: { start: "2026-10-26", end: "2026-11-01", zone: TENANT.timezone },
  groups: [
    { target: "spark", model: "muse-spark-1.3", status: "ok", calls: 12, costNanocents: 8_400_000_000, heldNanocents: 0, unsettled: 0, inputTokens: 4_000, cachedTokens: 1_000, savedNanocents: 10_000_000 },
    { target: "wonder", model: "muse-wonder-1.0", status: "ok", calls: 2, costNanocents: 11_600_000_000, heldNanocents: 0, unsettled: 0, inputTokens: 0, cachedTokens: 0, savedNanocents: 0 },
    { target: "sam", model: "sam-3.1", status: "failed", calls: 1, costNanocents: 250_000_000, heldNanocents: 0, unsettled: 0, inputTokens: 0, cachedTokens: 0, savedNanocents: 0 },
  ],
  latencies: [{ target: "spark", p50Ms: 1_840 }],
  decisions: [
    { decision: "allowed", count: 9 },
    { decision: "blocked", count: 2 },
  ],
  screenings: [{ verdict: "clean", via: "model", count: 4 }],
  escalations: 1,
});

export const DAY: DaySpend = { spentNanocents: 3_000_000_000, calls: 7 };
export const ALERTS: SpendAlert[] = [
  {
    id: id(62),
    traceId: id(63),
    purpose: "agent_operator_turn",
    spentNanocents: 1_100_000_000_000,
    limitNanocents: 1_000_000_000_000,
    createdAt: "2026-10-28T15:00:00.000Z",
    clearedAt: null,
    clearedByEmail: null,
  },
  {
    id: id(64),
    traceId: null,
    purpose: "document_read",
    spentNanocents: 1_050_000_000_000,
    limitNanocents: 1_000_000_000_000,
    createdAt: "2026-10-27T15:00:00.000Z",
    clearedAt: "2026-10-27T16:00:00.000Z",
    clearedByEmail: EMAIL,
  },
];

const counts: SweepCounts = {
  found: 3,
  fixes_drafted: 2,
  clean: 1,
  needs_person: 1,
  fixed_earlier: 0,
  declined_earlier: 0,
  expired_earlier: 0,
  refused: 0,
  blocked_live: 0,
  mismatch: 0,
  audit_pending: 0,
  over_cap: 0,
};

export const SWEEP_RUN: SweepRunView = {
  id: RUN_ID,
  periodId: PERIOD_ID,
  periodStart: "2026-10-26",
  periodEnd: "2026-11-01",
  trigger: "button",
  status: "done",
  phase: "done",
  capCents: 200,
  spentCents: 42,
  counts,
  truncatedReason: null,
  failureCategory: null,
  conversationId: id(51),
  startedAt: "2026-10-28T15:00:00.000Z",
  finishedAt: "2026-10-28T15:03:00.000Z",
  approved: 1,
};

export const SWEEP_HOME: SweepHome = {
  openPeriod: { id: PERIOD_ID, periodStart: "2026-10-26", periodEnd: "2026-11-01" },
  runs: [SWEEP_RUN, { ...SWEEP_RUN, id: id(9), status: "failed", failureCategory: "budget", finishedAt: null }],
};

const sweepItem = (over: Partial<SweepItemView>): SweepItemView => ({
  id: id(70),
  check: "missing_reimbursement",
  category: "missing_reimbursement",
  leg: 1,
  kind: "fix",
  driverCode: "BR-D07",
  driverName: "Rosa Delgado",
  expectedCents: 7_500,
  note: null,
  sourceRefs: [{ table: "pay_items", id: id(71) }],
  status: "drafted",
  refusalCategory: null,
  proposalId: id(72),
  proposalStatus: "proposed",
  amountCents: 7_500,
  direction: "out",
  auditorVerdict: "pass",
  decidedAt: null,
  clean: true,
  explanation: "The lumper receipt is on the load but not on the paystub.",
  explainCategory: null,
  auditAttempts: 1,
  ...over,
});

// How the week was checked a second time: one driver checked with a finding, one timed out, one
// past the run's limit, and a disagreement between the two checks.
export const SWEEP_FANOUT: FanoutTree = {
  status: "done",
  plan: { summary: "Start with the drivers with the most loads this week.", turnId: id(160) },
  skipped: [{ driverId: id(161), driverCode: "BR-D19", driverLabel: "Sam Roe", reason: "over_limit" }],
  checks: [
    {
      driverId: DRIVER_ID,
      driverCode: "BR-D07",
      driverLabel: "Rosa Ortiz",
      priority: 1,
      focus: ["no_load_that_day"],
      brief: "Insurance charged on a day with no load.",
      status: "done",
      confidence: "high",
      issues: [{ category: "no_load_that_day", sources: [{ table: "loads", id: LOAD_ID }], note: "Charged insurance on a day with no load." }],
      turnId: id(162),
      costCents: 4,
    },
    {
      driverId: id(163),
      driverCode: "BR-D12",
      driverLabel: "Marcus Hale",
      priority: 3,
      focus: [],
      brief: null,
      status: "timed_out",
      confidence: null,
      issues: [],
      turnId: null,
      costCents: 9,
    },
  ],
  reconcile: {
    counts: { engine: 3, agreed: 2, engine_only: 1, spark_only: 1, drivers_checked: 1, drivers_unchecked: 1 },
    summary: "Both checks agree on most of the week.",
    disagreements: [
      { driverId: DRIVER_ID, driverCode: "BR-D07", driverLabel: "Rosa Ortiz", category: "no_load_that_day", text: "Only the second check saw this day." },
    ],
    turnId: id(164),
  },
  finished: true,
};

export const SWEEP_PAGE: SweepPage = {
  run: SWEEP_RUN,
  items: [
    sweepItem({}),
    sweepItem({ id: id(73), proposalId: id(74), proposalStatus: "proposed", auditorVerdict: "concerns", clean: false }),
    sweepItem({
      id: id(75),
      kind: "needs_person",
      check: "fuel_wrong_driver",
      category: "fuel_wrong_driver",
      proposalId: null,
      proposalStatus: null,
      amountCents: null,
      direction: null,
      auditorVerdict: null,
      clean: false,
      status: "needs_person",
      note: "Two drivers bought fuel on the same card.",
      auditAttempts: 0,
    }),
  ],
  counts,
  proposals: {
    [id(72)]: proposal({ id: id(72), kind: "pay_correction", title: "Pay Rosa's lumper fee", destination: null }),
    [id(74)]: proposal({ id: id(74), kind: "pay_correction", title: "Pay Rosa's toll", auditorVerdict: "concerns", destination: null }),
  },
  clean: { proposalIds: [id(72)], totalCents: 7_500 },
  fanout: SWEEP_FANOUT,
};

const advanceRow = (over: Partial<AdvanceListRow>): AdvanceListRow => ({
  id: id(80),
  driverId: DRIVER_ID,
  driverCode: "BR-D07",
  driverName: "Rosa Delgado",
  requestRef: "ADV-1042",
  requestedOn: "2026-10-28",
  amountCents: 25_000,
  feeCents: 0,
  status: "paid",
  source: "ui",
  fromFlow: true,
  payoutState: "confirmed",
  cardLine: { label: "Paid to", card: { last4: "4417", status: "active" } },
  loadNumber: "BR-L10247",
  driverArmed: true,
  ...over,
});

export const ADVANCES: AdvanceListRow[] = [
  advanceRow({}),
  advanceRow({ id: id(81), status: "approved", payoutState: "reserved", source: "email" }),
  advanceRow({ id: id(82), status: "approved", payoutState: "unknown", source: "voice" }),
  advanceRow({ id: id(83), status: "paid", fromFlow: false, payoutState: null, source: "seed", cardLine: null, loadNumber: null }),
  advanceRow({ id: id(84), status: "requested", payoutState: null, driverArmed: false, cardLine: null }),
];

export const ADVANCE_RECORD: AdvanceRecord = {
  advance: {
    id: ID,
    driverId: DRIVER_ID,
    proposalId: id(30),
    requestRef: "ADV-1042",
    requestedAt: "2026-10-28T14:00:00.000Z",
    requestedOn: "2026-10-28",
    amountCents: 25_000,
    feeCents: 0,
    recoveredCents: 0,
    status: "approved",
    source: "email",
    sourceInputId: id(85),
    decidedAt: "2026-10-28T14:30:00.000Z",
    decidedByMembershipId: id(86),
    paidAt: null,
    loadId: LOAD_ID,
    takenBackCents: 0,
    takenBackAt: null,
    takenBackByMembershipId: null,
    takebackReason: null,
  },
  driver: { id: DRIVER_ID, code: "BR-D07", name: "Rosa Delgado" },
  card: { last4: "4417", status: "active", recorded: true },
  proposal: {
    id: id(30),
    status: "executing",
    title: "Fuel advance for Rosa Delgado",
    decisionNote: null,
    operatorVerdict: "allowed",
    flagged: false,
    createdAt: "2026-10-28T14:01:00.000Z",
    decidedAt: "2026-10-28T14:30:00.000Z",
  },
  ledger: [
    {
      id: id(87),
      kind: "advance_payout",
      state: "unknown",
      attempt: 1,
      amountCents: 25_000,
      failureCategory: "timeout",
      outsideSystem: "fuel_card_sim",
      outsideTail: "a9b3",
      createdAt: "2026-10-28T14:30:00.000Z",
      settledAt: null,
    },
    {
      id: id(88),
      kind: "advance_payout",
      state: "reserved",
      attempt: 2,
      amountCents: 25_000,
      failureCategory: null,
      outsideSystem: null,
      outsideTail: null,
      createdAt: "2026-10-28T14:35:00.000Z",
      settledAt: null,
    },
  ],
  input: { id: id(85), kind: "email", receivedAt: "2026-10-28T13:59:00.000Z" },
  eligibility: {
    eligible: true,
    maxCents: 40_000,
    feeCents: 0,
    earnedUnpaidCents: 120_000,
    openCents: 25_000,
    limitCents: 50_000,
    minCents: 5_000,
    shareBps: 5_000,
    reasons: [],
    sources: [{ table: "loads", id: LOAD_ID }],
  },
  actions: { retry: true, check: true, post: true, takeBack: true },
  load: { id: LOAD_ID, number: "BR-L10247" },
  headroom: { capCents: 50_000, openOnLoadCents: 25_000, headroomCents: 25_000 },
  siblingsOnLoad: [{ id: id(89), requestRef: "ADV-1040", amountCents: 10_000, status: "paid" }],
  takeback: null,
};

export const DRIVER_ADVANCES: DriverAdvance[] = [
  { id: id(80), requestRef: "ADV-1042", requestedOn: "2026-10-28", amountCents: 25_000, status: "paid" },
  { id: id(84), requestRef: "ADV-1044", requestedOn: "2026-10-29", amountCents: 10_000, status: "requested" },
];

export const IDENTITY: DriverIdentity = {
  driverId: DRIVER_ID,
  code: "BR-D07",
  name: "Rosa Delgado",
  activeTo: null,
  armed: { on: true, since: "2026-10-05T12:00:00.000Z" },
  tmsIds: ["TMS-BR-14607"],
  cards: [
    { id: id(90), last4: "4417", status: "active", isDefault: true, holderKind: "named", portalName: null, testMode: true },
    { id: id(91), last4: "9921", status: "closed", isDefault: false, holderKind: "generic", portalName: "DRIVER 07", testMode: true },
  ],
};

const invoiceRow = (over: Partial<InvoiceListRow>): InvoiceListRow => ({
  id: INVOICE_ID,
  invoiceNumber: "BR-INV-10244",
  customerId: CUSTOMER_ID,
  customerName: "Tanglewood Grocery Supply",
  loadId: LOAD_ID,
  status: "open",
  amountCents: 182_500,
  balanceCents: 182_500,
  issuedOn: "2026-10-20",
  dueOn: "2026-11-19",
  bucket: "current",
  posted: true,
  ...over,
});

export const INVOICES: InvoiceListRow[] = [
  invoiceRow({}),
  invoiceRow({ id: id(100), invoiceNumber: "BR-INV-10101", status: "past_due", bucket: "31_60", dueOn: "2026-09-15", posted: false }),
  invoiceRow({ id: id(101), invoiceNumber: "BR-INV-10102", status: "partially_paid", balanceCents: 50_000, bucket: "over_90" }),
  invoiceRow({ id: id(102), invoiceNumber: "BR-INV-10103", status: "paid", balanceCents: 0, bucket: null }),
];

export const QUEUE: { invoiceable: QueueItemRow[]; exceptions: QueueItemRow[] } = {
  invoiceable: [
    { loadId: LOAD_ID, loadNumber: "BR-L10247", customerName: "Tanglewood Grocery Supply", deliveredOn: "2026-10-27", amountCents: 182_500, reason: null },
  ],
  exceptions: [
    { loadId: id(103), loadNumber: "BR-L10250", customerName: "Tanglewood Grocery Supply", deliveredOn: "2026-10-27", amountCents: null, reason: "missing_rate" },
  ],
};

const application = {
  id: id(104),
  paymentId: PAYMENT_ID,
  paymentRef: "BR-PAY-88",
  invoiceId: INVOICE_ID,
  invoiceNumber: "BR-INV-10244",
  receivedOn: "2026-10-29",
  amountCents: 100_000,
};
const ledgerRows = [
  { id: id(105), attempt: 1, state: "unknown" as const, failureCategory: "timeout", amountCents: 182_500, createdAt: "2026-10-28T15:00:00.000Z" },
  { id: id(106), attempt: 2, state: "confirmed" as const, failureCategory: null, amountCents: 182_500, createdAt: "2026-10-28T15:10:00.000Z" },
];

export const INVOICE_RECORD: InvoiceRecordView = {
  ...invoiceRow({ status: "partially_paid", balanceCents: 82_500 }),
  source: "app",
  loadNumber: "BR-L10247",
  qboTail: "0412",
  lines: [
    { kind: "linehaul", label: "Linehaul", amountCents: 150_000 },
    { kind: "fuel_surcharge", label: "Fuel surcharge", amountCents: 19_000 },
    { kind: "accessorial", label: "Detention at receiver", amountCents: 13_500 },
  ],
  applications: [application],
  ledger: ledgerRows,
};

export const PAYMENT_RECORD: PaymentRecordView = {
  id: PAYMENT_ID,
  customerId: CUSTOMER_ID,
  customerName: "Tanglewood Grocery Supply",
  receivedOn: "2026-10-29",
  method: "ach",
  paymentRef: "BR-PAY-88",
  source: "app",
  amountCents: 120_000,
  appliedCents: 100_000,
  creditCents: 20_000,
  posted: false,
  qboTail: null,
  invoicesPosted: true,
  applications: [application],
  ledger: ledgerRows,
};

export const CUSTOMER_RECORD: CustomerRecordView = {
  id: CUSTOMER_ID,
  code: "BR-C01",
  name: "Tanglewood Grocery Supply",
  termsDays: 45,
  invoices: INVOICES,
  payments: [{ id: PAYMENT_ID, receivedOn: "2026-10-29", method: "check", paymentRef: "BR-PAY-88", amountCents: 120_000, creditCents: 20_000 }],
  creditCents: 20_000,
  aging: {
    current: 182_500 as Cents,
    "1_30": 0 as Cents,
    "31_60": 182_500 as Cents,
    "61_90": 0 as Cents,
    over_90: 50_000 as Cents,
  },
  agingTotalCents: 415_000,
  podRequired: true,
  billingDomain: "tanglewood.example",
};

export const LOAD_RECORD: LoadRecordView = {
  id: LOAD_ID,
  loadNumber: "BR-L10247",
  status: "delivered",
  customerId: CUSTOMER_ID,
  customerName: "Tanglewood Grocery Supply",
  lane: "Atlanta, GA to Charlotte, NC",
  pickupOn: "2026-10-26",
  deliveredOn: "2026-10-27",
  loadedMiles: 245,
  emptyMiles: 30,
  linehaulCents: 150_000,
  fuelSurchargeCents: 19_000,
  stateMiles: [
    { state: "GA", miles: 160 },
    { state: "SC", miles: 85 },
  ],
  accessorials: [{ id: id(107), kind: "detention", amountCents: 13_500 }],
  invoice: { id: INVOICE_ID, invoiceNumber: "BR-INV-10244", status: "open" },
  engine: {
    ok: true,
    amountCents: 182_500,
    lines: [
      { kind: "linehaul", label: "Linehaul", amountCents: 150_000 },
      { kind: "fuel_surcharge", label: "Fuel surcharge", amountCents: 19_000 },
      { kind: "accessorial", label: "Detention at receiver", amountCents: 13_500 },
    ],
  },
};

export const PAYMENT_FORM: PaymentFormCustomer[] = [
  {
    id: CUSTOMER_ID,
    code: "BR-C01",
    name: "Tanglewood Grocery Supply",
    invoices: [
      { id: id(100), invoiceNumber: "BR-INV-10101", dueOn: "2026-09-15", balanceCents: 182_500 },
      { id: INVOICE_ID, invoiceNumber: "BR-INV-10244", dueOn: "2026-11-19", balanceCents: 182_500 },
    ],
  },
];

const document = (over: Partial<DocumentView>): DocumentView => ({
  id: ID,
  filename: "lumper-receipt.jpg",
  mime: "image/jpeg",
  byteLength: 182_000,
  pageCount: 1,
  readStatus: "read",
  kind: "lumper_receipt",
  read: {
    kind: "lumper_receipt",
    fields: {
      sampleWord: true,
      vendor: "Dockside Unloading",
      date: "10/27/2026",
      totalCents: 7_500,
      loadNumber: "BR-L10247",
      truckUnit: "T-118",
      gallonsMilli: null,
      priceCents: null,
      loadedMiles: null,
      ratePerMileCents: null,
      linehaulCents: null,
      fuelSurchargeCents: null,
      customerName: null,
      stops: [{ role: "delivery", arrived: "10/27/2026 08:10", departed: "10/27/2026 11:40" }],
    },
    textLines: ["SAMPLE", "Dockside Unloading", "Load BR-L10247", "Total 75.00"],
    confidence: {
      document_kind: "high",
      vendor: "high",
      date_mmddyyyy: "high",
      total_cents: "high",
      load_number: "high",
      truck_unit: "medium",
      gallons_milli: "low",
      price_cents: "low",
      loaded_miles: "low",
      rate_per_mile_cents: "low",
      linehaul_cents: "low",
      fuel_surcharge_cents: "low",
      customer_name: "low",
      stops: "medium",
    },
  },
  match: {
    found: true,
    table: "load_accessorials",
    id: id(107),
    humanRef: "BR-L10247",
    loadId: LOAD_ID,
    driverId: DRIVER_ID,
    fields: [
      { name: "total_cents", claim: 7_500, record: 7_500, status: "same" },
      { name: "date_mmddyyyy", claim: "10/27/2026", record: null, status: "no_record_value" },
      { name: "truck_unit", claim: "T-118", record: "T-120", status: "differs" },
    ],
    notes: ["reimbursement_missing"],
    supports: "missing_reimbursement",
  },
  inputId: id(108),
  readCallId: id(109),
  traceId: id(110),
  createdAt: "2026-10-28T15:00:00.000Z",
  stalled: false,
  readAttempts: 1,
  ...over,
});

export const DOCUMENTS: DocumentView[] = [
  document({}),
  document({ id: id(111), filename: "rate-con.pdf", mime: "application/pdf", readStatus: "pending", kind: null, read: null, match: null, readCallId: null }),
  document({ id: id(112), filename: "blurry.png", mime: "image/png", readStatus: "unreadable", kind: null, read: null, match: { found: false, reason: "unreadable" }, readAttempts: 3 }),
  document({ id: id(113), filename: "late.webp", mime: "image/webp", readStatus: "budget", kind: null, read: null, match: null }),
];

export const CLIPS: ClipView[] = [
  {
    id: ID,
    loadId: LOAD_ID,
    loadNumber: "BR-L10247",
    stop: "delivery",
    filename: "dock-door-4.mp4",
    status: "read",
    width: 1280,
    height: 720,
    fps: 30,
    frameCount: 900,
    durationMs: 30_000,
    planReady: true,
    redactedByteLength: 2_400_000,
    reading: {
      arrival: { clockText: "8:10 AM", dateText: "10/27/2026", atSeconds: 2, confidence: "high" },
      departure: { clockText: "11:40 AM", dateText: "10/27/2026", atSeconds: 28, confidence: "medium" },
      bolNumber: { value: "BOL-55120", atSeconds: 12, confidence: "high" },
      sealNumber: null,
      doorText: "DOOR 4",
      agreement: { result: "differs", arrivalMinutesOff: 20, departureMinutesOff: 0 },
    },
    coverage: { faceFrames: 12, plateFrames: 4 },
    createdAt: "2026-10-28T15:00:00.000Z",
    redactedAt: "2026-10-28T15:01:00.000Z",
    readAt: "2026-10-28T15:02:00.000Z",
  },
  {
    id: id(120),
    loadId: LOAD_ID,
    loadNumber: "BR-L10247",
    stop: "pickup",
    filename: "pickup.mp4",
    status: "budget",
    width: 1280,
    height: 720,
    fps: 30,
    frameCount: 300,
    durationMs: 10_000,
    planReady: false,
    redactedByteLength: null,
    reading: null,
    coverage: null,
    createdAt: "2026-10-28T15:10:00.000Z",
    redactedAt: null,
    readAt: null,
  },
];

export const CLIP_LOADS = [{ id: LOAD_ID, load_number: "BR-L10247", dest_city: "Charlotte", dest_state: "NC" }];

const runSummary: RunSummary = {
  id: RUN_ID,
  loadId: LOAD_ID,
  loadNumber: "BR-L10247",
  reference: "FFE-104233",
  status: "done",
  endedReason: "answered",
  model: "wonder",
  stepCount: 4,
  costNanocents: 3_400_000_000,
  createdAt: "2026-10-28T15:00:00.000Z",
  finishedAt: "2026-10-28T15:04:00.000Z",
  requestedBy: EMAIL,
  stalled: false,
};

export const RUNS: RunSummary[] = [
  runSummary,
  { ...runSummary, id: id(121), status: "waiting_approval", endedReason: null, finishedAt: null },
  { ...runSummary, id: id(122), status: "failed", endedReason: "budget", stalled: true },
];

export const RUN_CHOICES = [{ loadId: LOAD_ID, loadNumber: "BR-L10247", reference: "FFE-104233" }];

export const RUN_VIEW: RunView = {
  run: runSummary,
  steps: [
    { seq: 1, kind: "opening", executed: true, stoppedEarly: false, hasScreenshot: true, sentences: ["Opened the broker's portal."], costNanocents: 0, pendingCheckCount: 0, createdAt: "2026-10-28T15:00:00.000Z" },
    { seq: 2, kind: "action", executed: true, stoppedEarly: false, hasScreenshot: true, sentences: ["Clicked the load row at 640, 410"], costNanocents: 900_000_000, pendingCheckCount: 0, createdAt: "2026-10-28T15:01:00.000Z" },
    { seq: 3, kind: "answer", executed: true, stoppedEarly: false, hasScreenshot: false, sentences: ["Read the check-in and check-out times."], costNanocents: 1_100_000_000, pendingCheckCount: 0, createdAt: "2026-10-28T15:03:00.000Z" },
  ],
  checks: [
    { id: id(123), stepSeq: 2, status: "approved", category: "submit_form", createdAt: "2026-10-28T15:01:00.000Z", decidedAt: "2026-10-28T15:02:00.000Z" },
  ],
  evidence: {
    runId: RUN_ID,
    checkedIn: "2026-10-27 08:10 ET",
    checkedOut: "2026-10-27 11:40 ET",
    checkedInAt: "2026-10-27T12:10:00.000Z",
    checkedOutAt: "2026-10-27T15:40:00.000Z",
    zoneLabel: "ET",
    minutesAtDock: 210,
    pod: "present",
    podBytes: 52_000,
    timesStepSeq: 3,
    podStepSeq: 3,
    screenVerdict: "clean",
    readback: "matches",
    untrustedInputId: id(124),
    createdAt: "2026-10-28T15:04:00.000Z",
  },
  calls: [
    { id: id(125), target: "wonder", purpose: "portal_step", status: "ok", costNanocents: 900_000_000, durationMs: 2_100, inputTokens: 1_200, outputTokens: 80 },
    { id: id(126), target: "spark", purpose: "screen", status: "reserved", costNanocents: null, durationMs: null, inputTokens: null, outputTokens: null },
  ],
};

export const PORTAL_LINES: PortalLoadLine[] = [
  { reference: "FFE-104233", loadNumber: "BR-L10247", consignee: "Tanglewood Grocery", destination: "Charlotte, NC", podStatus: "available" },
];
export const PORTAL_DETAIL: PortalLoadDetail = {
  ...PORTAL_LINES[0],
  shipper: "Peach State Foods",
  scheduledWindow: "2026-10-27 08:00 to 10:00 ET",
  checkedIn: "2026-10-27 08:10 ET",
  checkedOut: "2026-10-27 11:40 ET",
  podSignedBy: "J. Moore",
  notes: "Door 4",
};

const voiceRow = (over: Partial<VoiceListRow>): VoiceListRow => ({
  id: ID,
  driverId: DRIVER_ID,
  driverCode: "BR-D07",
  driverName: "Rosa Delgado",
  status: "ready",
  failCategory: null,
  language: "es",
  category: "advance_request",
  urgency: "high",
  amountCents: 25_000,
  durationMs: 9_000,
  createdAt: "2026-10-28T15:00:00.000Z",
  ...over,
});

export const VOICE_LIST: VoiceListRow[] = [
  voiceRow({}),
  voiceRow({ id: id(130), status: "blocked", category: null, urgency: "low", amountCents: null }),
  voiceRow({ id: id(131), status: "failed", failCategory: "budget", language: null, category: null, urgency: null }),
  voiceRow({ id: id(132), status: "replied", category: "pay_question", urgency: "normal", amountCents: null }),
];

export const VOICE_DETAIL: VoiceDetail = {
  ...voiceRow({ status: "handed_off" }),
  inputId: id(133),
  traceId: id(134),
  hasAudio: true,
  audioMime: "audio/wav",
  confidenceMilli: 910,
  transcript: "Necesito un adelanto de doscientos cincuenta dolares para diesel.",
  englishText: "I need a two hundred fifty dollar advance for diesel.",
  replyText: "Your request is with the office.",
  conversationId: id(51),
  screen: { verdict: "clean", categories: [] },
  proposal: { id: id(30), status: "proposed", amountCents: 25_000 },
  trace: [
    { target: "voice", purpose: "voice_transcribe", status: "ok", durationMs: 2_000, costNanocents: 300_000_000 },
    { target: "spark_open", purpose: "voice_triage", status: "ok", durationMs: 400, costNanocents: 10_000_000 },
  ],
};

// One settled paystub from the seed, so the driver's view shows real line labels.
const plan = buildCarrierPlan(DEMO_CARRIERS[0], DEMO_ANCHOR);
const settled = (() => {
  const withRecovery = plan.rows.settlement_lines.find((l) => l.kind === "advance_recovery");
  const settlement = plan.rows.settlements.find((s) => s.id === withRecovery?.settlement_id) ?? plan.rows.settlements[0];
  const period = plan.rows.settlement_periods.find((p) => p.id === settlement.period_id)!;
  const driver = plan.rows.drivers.find((d) => d.id === settlement.driver_id)!;
  const lines = plan.rows.settlement_lines.filter((l) => l.settlement_id === settlement.id);
  return { settlement, period, driver, lines };
})();

export const PERIODS: NotePeriod[] = [
  { id: settled.period.id, periodStart: settled.period.period_start, periodEnd: settled.period.period_end, settled: 25, drafted: 3, approved: 1, waiting: 2 },
];

export const PERIOD_NOTES: PeriodNotes = {
  period: { id: settled.period.id, periodStart: settled.period.period_start, periodEnd: settled.period.period_end },
  cards: [
    {
      settlementId: settled.settlement.id,
      driverName: `${settled.driver.first_name} ${settled.driver.last_name}`,
      driverCode: settled.driver.code,
      language: "en",
      netCents: settled.settlement.net_cents,
      note: {
        id: id(140),
        status: "drafted",
        language: "en",
        body: "Your pay is lower this week because an advance was repaid.",
        citedSeqs: settled.lines.map((l) => l.seq).slice(0, 3),
        refusalCategory: null,
        decidedAt: null,
      },
      citedLines: settled.lines.map((l) => ({ seq: l.seq, label: l.label })),
      fallback: "Net pay this week is on your paystub.",
    },
    {
      settlementId: id(141),
      driverName: "Marcus Hale",
      driverCode: "BR-D12",
      language: "es",
      netCents: 150_000,
      note: { id: id(142), status: "failed", language: "es", body: null, citedSeqs: [], refusalCategory: "number_mismatch", decidedAt: null },
      citedLines: [],
      fallback: "El pago neto de esta semana está en su talón.",
    },
  ],
};

export const DRIVER_VIEW: DriverView = {
  source: {
    settlement: settled.settlement,
    period: settled.period,
    driver: settled.driver,
    lines: settled.lines,
    previousNetCents: null,
  },
  message: { kind: "note", body: "Your pay is lower this week because an advance was repaid.", language: "en" },
};

export const DEMO_PREVIEW: DemoResetPreview = {
  carrier: DEMO_CARRIERS[0],
  current: Object.fromEntries(
    RESET_TABLES.map((table) => [table, table in plan.rows ? (plan.rows as Record<string, unknown[]>)[table].length : 3]),
  ) as DemoResetPreview["current"],
  refusals: [
    { kind: "open", count: 1 },
    { kind: "mismatch", count: 1 },
    { kind: "flagged", count: 2 },
  ],
};

export const QBO = { realmTail: "0869", connectedAt: "2026-10-26T15:00:00Z" };

// The pay week screens, from the seed's own paystub: a clean one, one with an exception and a
// second check that disagrees, a parked one, and an approved one.
const SETTLED_NAME = `${settled.driver.first_name} ${settled.driver.last_name}`;
const OPEN_WEEK = { id: settled.period.id, start: settled.period.period_start, end: settled.period.period_end, status: "open" };
const PAID_WEEK = { id: id(150), start: "2026-10-12", end: "2026-10-18", status: "paid" };

const settlementRow = (over: Partial<SettlementListRow>): SettlementListRow => ({
  id: settled.settlement.id,
  driverId: settled.driver.id,
  driverCode: settled.driver.code,
  driverName: SETTLED_NAME,
  grossCents: settled.settlement.gross_cents,
  deductionsCents: settled.settlement.deductions_cents,
  netCents: settled.settlement.net_cents,
  exceptionCount: 0,
  exceptions: [],
  status: "draft",
  parkedReason: null,
  parkedLabel: null,
  proposalId: id(151),
  proposalStatus: "proposed",
  auditor: "agree",
  auditorAgrees: true,
  clean: true,
  ...over,
});

export const SETTLEMENTS_VIEW: SettlementsView = {
  periods: [OPEN_WEEK, PAID_WEEK],
  period: OPEN_WEEK,
  rows: [
    settlementRow({}),
    settlementRow({
      id: id(152),
      driverId: DRIVER_ID,
      driverCode: "BR-D07",
      driverName: "Rosa Ortiz",
      exceptionCount: 1,
      exceptions: [exceptionLabel("load_rate_missing")],
      proposalId: id(153),
      auditor: "disagree",
      auditorAgrees: false,
      clean: false,
    }),
    settlementRow({
      id: id(154),
      driverId: id(155),
      driverCode: "BR-D12",
      driverName: "Marcus Hale",
      parkedReason: "line_amount_changed",
      parkedLabel: parkLabel("line_amount_changed"),
      proposalId: null,
      proposalStatus: null,
      auditor: null,
      auditorAgrees: null,
      clean: false,
    }),
    settlementRow({
      id: id(156),
      driverId: id(157),
      driverCode: "BR-D19",
      driverName: "Sam Roe",
      status: "approved",
      proposalStatus: "approved",
      auditor: "unknown",
      auditorAgrees: null,
      clean: false,
    }),
  ],
  clean: {
    items: [
      {
        proposalId: id(151),
        settlementId: settled.settlement.id,
        driverId: settled.driver.id,
        driverCode: settled.driver.code,
        driverName: SETTLED_NAME,
        netCents: settled.settlement.net_cents,
      },
    ],
    totalCents: settled.settlement.net_cents,
  },
  awaitingAuditor: 0,
  exemptDrivers: [{ id: DRIVER_ID, code: "BR-D07", name: "Rosa Ortiz" }],
};

const PAY_LINES: PayLine[] = settled.lines.map((l) => ({
  seq: l.seq,
  kind: l.kind as PayLine["kind"],
  label: l.label,
  amountCents: l.amount_cents as Cents,
  sources: l.sources.map((r) => ({ table: r.table, id: r.id })) as PayLine["sources"],
}));

const leg = (n: number, kind: SettlementRecordView["legs"][number]["kind"], state: SettlementRecordView["legs"][number]["state"], over = {}) => ({
  id: id(170 + n),
  kind,
  attempt: 1,
  state,
  failureCategory: null,
  settledVia: null,
  batchId: null,
  amountCents: settled.settlement.net_cents,
  createdAt: "2026-10-27T15:00:00.000Z",
  ...over,
});

export const SETTLEMENT_RECORD: SettlementRecordView = {
  settlement: {
    id: settled.settlement.id,
    periodId: settled.period.id,
    driverId: settled.driver.id,
    status: "approved",
    grossCents: settled.settlement.gross_cents,
    deductionsCents: settled.settlement.deductions_cents,
    netCents: settled.settlement.net_cents,
    carryForwardCents: 0,
    exceptionCount: 1,
    paidAt: null,
    parkedReason: null,
    parkedAt: null,
  },
  lines: PAY_LINES,
  period: { id: settled.period.id, start: settled.period.period_start, end: settled.period.period_end, status: "open" },
  driver: { id: settled.driver.id, code: settled.driver.code, name: SETTLED_NAME, workerType: "company", ownInsurance: true },
  proposal: {
    id: id(151),
    status: "approved",
    note: "not_paid_yet",
    exceptions: [{ category: "load_rate_missing", label: exceptionLabel("load_rate_missing") }],
  },
  legs: [
    leg(1, "settlement_payout", "failed", { failureCategory: "timeout" }),
    leg(2, "settlement_payout", "unknown", { attempt: 2 }),
    leg(3, "settlement_bill", "reserved"),
  ],
  latest: { settlement_payout: "unknown", settlement_bill: "reserved", settlement_bill_payment: null },
  parkedLabel: null,
};

export const DRIVER_RECORD: DriverRecordView = {
  id: settled.driver.id,
  code: settled.driver.code,
  name: SETTLED_NAME,
  workerType: "owner_operator",
  payBasis: "percent",
  escrowBalanceCents: 125_000,
  ownInsurance: true,
  activeFrom: "2025-03-03",
  activeTo: null,
  settlements: [
    { id: settled.settlement.id, periodStart: settled.period.period_start, periodEnd: settled.period.period_end, status: "draft", netCents: settled.settlement.net_cents, parked: false },
    { id: id(154), periodStart: "2026-10-12", periodEnd: "2026-10-18", status: "paid", netCents: 180_000, parked: true },
  ],
  advances: [
    { id: id(180), requestedOn: "2026-10-21", amountCents: 30_000, status: "paid", recoveredCents: 30_000 },
    { id: id(181), requestedOn: "2026-10-24", amountCents: 20_000, status: "proposed", recoveredCents: 0 },
  ],
};

export const BATCH_RECORD: BatchRecordView = {
  id: id(190),
  periodId: settled.period.id,
  status: "draining",
  totalCents: settled.settlement.net_cents + 180_000,
  legsReserved: 4,
  createdAt: "2026-10-27T15:00:00.000Z",
  finishedAt: null,
  items: [
    {
      settlementId: settled.settlement.id,
      driverCode: settled.driver.code,
      driverName: SETTLED_NAME,
      netCents: settled.settlement.net_cents,
      legs: { settlement_payout: "confirmed", settlement_bill: "unknown", settlement_bill_payment: null },
    },
    {
      settlementId: id(154),
      driverCode: "BR-D12",
      driverName: "Marcus Hale",
      netCents: 180_000,
      legs: { settlement_payout: "reserved", settlement_bill: null, settlement_bill_payment: null },
    },
  ],
};

export const PAYSTUB_ASK = { driverName: SETTLED_NAME, periodEnd: settled.period.period_end };

// The invoice review: the record page's card and the Review tab, with the real labels and
// sentences for each reason.
const REVIEW_DETAIL = {
  amountCents: 182_500,
  engineTotalCents: 165_000,
  engineLinehaulCents: 150_000,
  ratedCents: 140_000,
  qboAmountCents: 180_000,
  failureCategory: "validation",
  duplicateNumbers: ["BR-INV-10240"],
  documentsRead: false,
};

export const reviewView = (status: InvoiceReviewStatus, reasons: InvoiceReviewReason[], over: Partial<InvoiceReviewView> = {}): InvoiceReviewView => ({
  invoiceId: INVOICE_ID,
  invoiceNumber: "BR-INV-10247",
  invoiceStatus: "open",
  customerId: CUSTOMER_ID,
  loadId: LOAD_ID,
  amountCents: 182_500,
  issuedOn: "2026-10-28",
  review: { status, reasons, sources: [], sentOn: null, duplicateOf: [] },
  statusLabel: REVIEW_STATUS_LABELS[status],
  reasons: reasons.map((reason) => ({ reason, label: REVIEW_REASON_LABELS[reason], sentence: reviewReasonSentence(reason, REVIEW_DETAIL) })),
  inQueue: true,
  posted: false,
  madeByQueue: true,
  emailStatus: null,
  qboAmountCents: null,
  reviewedAt: null,
  reviewedByMembershipId: null,
  reviewNote: null,
  sentOn: null,
  sentByMembershipId: null,
  duplicates: [],
  posting: null,
  podRequired: true,
  ...over,
});

export const INVOICE_REVIEW = reviewView("rate_mismatch", ["engine_total_differs", "rate_confirmation_differs", "no_delivery_document", "not_reviewed"]);

const queueRow = (n: number, status: InvoiceReviewStatus, firstReason: InvoiceReviewReason | null, over = {}) => ({
  id: id(200 + n),
  invoiceNumber: `BR-INV-1025${n}`,
  customerId: CUSTOMER_ID,
  customerName: "Tanglewood Grocery Supply",
  loadId: LOAD_ID,
  amountCents: 182_500,
  issuedOn: "2026-10-28",
  status,
  statusLabel: REVIEW_STATUS_LABELS[status],
  firstReason,
  firstReasonLabel: firstReason === null ? null : REVIEW_REASON_LABELS[firstReason],
  posted: false,
  madeByQueue: true,
  emailStatus: null,
  sentOn: null,
  ...over,
});

export const REVIEW_QUEUE: ReviewQueue = {
  counts: { sync_error: 1, rate_mismatch: 1, missing_documents: 1, duplicate_warning: 1, needs_review: 1, ready_to_send: 2 },
  rows: [
    queueRow(1, "sync_error", "posting_failed"),
    queueRow(2, "rate_mismatch", "engine_total_differs"),
    queueRow(3, "missing_documents", "no_delivery_document"),
    queueRow(4, "duplicate_warning", "same_amount_recent"),
    queueRow(5, "needs_review", "not_reviewed"),
    queueRow(6, "ready_to_send", "not_posted"),
    queueRow(7, "ready_to_send", null, { posted: true, emailStatus: "need_to_send" }),
  ],
};

// ---- The profit brief: one closed week priced by the real engine, and its brief in each state ----

const PROFIT_PERIOD = { start: "2026-10-19", end: "2026-10-25" };
const PIEDMONT_ID = id(401);
const marginLine = (n: number, over: Partial<MarginLine>): MarginLine => ({
  loadId: id(410 + n),
  loadNumber: `BR-L1024${n}`,
  deliveredOn: "2026-10-22",
  customerId: CUSTOMER_ID,
  customerName: "Tanglewood Grocery Supply",
  driverId: DRIVER_ID,
  driverName: "Rosa Delgado (BR-D07)",
  lane: { originCity: "Roanoke", originState: "VA", destCity: "Charlotte", destState: "NC" },
  loadedMiles: 290,
  revenueCents: 185_000,
  driverPayCents: 116_000,
  marginCents: 69_000,
  marginBps: 3730,
  note: null,
  ...over,
});
const PROFIT_LINES: MarginLine[] = [
  marginLine(1, {}),
  marginLine(2, {
    lane: { originCity: "Charlotte", originState: "NC", destCity: "Atlanta", destState: "GA" },
    loadedMiles: 245,
    revenueCents: 142_000,
    driverPayCents: 98_000,
    marginCents: 44_000,
    marginBps: 3099,
  }),
  marginLine(3, { customerId: PIEDMONT_ID, customerName: "Piedmont Paper Co", revenueCents: 176_000, driverPayCents: 121_000, marginCents: 55_000, marginBps: 3125 }),
  // Delivered with no rate: counted and listed, never priced.
  marginLine(4, { customerId: PIEDMONT_ID, customerName: "Piedmont Paper Co", revenueCents: null, driverPayCents: null, marginCents: null, marginBps: null, note: "No rate on the load" }),
];
const priced = profitWeek(
  { lines: PROFIT_LINES, receivables: { invoices: [], payments: [], applications: [], asOf: PROFIT_PERIOD.end } },
  PROFIT_PERIOD,
  { maxLanes: 10, maxCustomers: 12 },
);
// How each customer pays, set by hand so the table shows a mean and every habit word.
export const PROFIT_WEEK = {
  ...priced,
  customers: priced.customers.map((c, i) => (i === 0 ? { ...c, meanDays: 31, paidCount: 6, habit: "repeat_late" as const } : c)),
};
const PROFIT_WEEKS: ClosedWeek[] = [
  { id: id(402), ...PROFIT_PERIOD },
  { id: id(403), start: "2026-10-12", end: "2026-10-18" },
];

// The brief's words, built from the figures so the number check passes and every number links.
const cite = (label: string): string => {
  const figure = PROFIT_WEEK.figures.find((f) => f.label === label);
  if (!figure) throw new Error(`no figure ${label}`);
  return `${figureValueText(figure)} [${figure.key}]`;
};
export const PROFIT_BRIEF_TEXT =
  `Revenue was ${cite("Revenue")} against driver pay of ${cite("Driver pay")}, a margin of ${cite("Margin")} or ` +
  `${cite("Margin percent")}. Tanglewood Grocery Supply gave the most margin at ${cite("Customer Tanglewood Grocery Supply: margin")}.`;

export const PROFIT_BRIEF: BriefRecord = {
  id: id(404),
  status: "drafted",
  periodStart: PROFIT_PERIOD.start,
  periodEnd: PROFIT_PERIOD.end,
  asOf: "2026-10-27",
  figures: PROFIT_WEEK.figures,
  text: PROFIT_BRIEF_TEXT,
  category: null,
  updatedAt: "2026-10-27T15:00:00.000Z",
};

export const profitView = (brief: ProfitView["brief"], over: Partial<ProfitView> = {}): ProfitView => ({
  weeks: PROFIT_WEEKS,
  week: PROFIT_WEEKS[0],
  profit: PROFIT_WEEK,
  brief,
  ...over,
});

export const PROFIT_VIEW = profitView({ kind: "none" });

// ---- Cash Friday: a short week with all three moves, every receipt and bill status ----

const BILL_ID = id(60);
const LATE_CUSTOMER_ID = id(61);
const reason = (category: string, source?: { table: string; id: string }) => ({ category, text: reasonSentence(category), source: source ?? null });

export const VENDOR_BILL: VendorBillView = {
  id: BILL_ID,
  billRef: "BR-NTB-2229",
  vendorName: "Northline Tire and Brake",
  category: "maintenance",
  amountCents: 888_424,
  dueOn: "2026-11-06",
  urgency: "flexible",
  status: "open",
  deferredTo: null,
  paidOn: null,
};

export const VENDOR_BILLS: VendorBillView[] = [
  VENDOR_BILL,
  { ...VENDOR_BILL, id: id(62), billRef: "BR-SFI-1107", vendorName: "Summit Fleet Insurance", category: "insurance", amountCents: 1_240_000, urgency: "fixed" },
  { ...VENDOR_BILL, id: id(63), billRef: "BR-RTL-0412", vendorName: "Ridgeline Truck Leasing", category: "lease", status: "deferred", deferredTo: "2026-11-20" },
  { ...VENDOR_BILL, id: id(64), billRef: "BR-ORT-0388", vendorName: "Open Road Tolls", category: "tolls", amountCents: 41_250, status: "paid", paidOn: "2026-10-30" },
];

export const CASH_CHECK: CashCheckView = {
  id: id(65),
  asOf: "2026-11-02",
  payDay: "2026-11-06",
  createdAt: "2026-11-02T14:00:00.000Z",
  payRunSource: "preview",
  figures: {
    bankBalanceCents: 1_449_362,
    balanceAsOf: "2026-11-01",
    cashOnHandCents: 1_449_362,
    expectedReceiptsCents: 8_813_237,
    payRunCents: 2_713_852,
    fuelLoadsCents: 0,
    vendorBillsDueCents: 8_228_747,
    gapCents: -680_000,
  },
  lines: (["counted", "after_pay_day", "stalled"] as const).map((status, n) => ({
    invoiceId: id(66 + n),
    invoiceNumber: `BR-INV-1026${n}`,
    customerId: n === 2 ? LATE_CUSTOMER_ID : CUSTOMER_ID,
    customerName: n === 2 ? "Harbor Point Foods" : "Tanglewood Grocery Supply",
    balanceCents: 182_500,
    dueOn: "2026-10-30",
    expectedOn: "2026-11-04",
    onTimeBps: [9_250, 6_000, 2_500][n],
    label: (["reliable", "mixed", "repeat_late"] as const)[n],
    status,
    expectedCents: status === "counted" ? 168_812 : 0,
  })),
  explanation:
    "Cash on hand of $14,493.62 and $88,132.37 expected by Friday do not cover the $27,138.52 pay run and $82,287.47 of bills due, so Friday is short by $6,800.00. Delaying the $8,884.24 tire bill covers it on its own; factoring narrows it.",
  explainCategory: null,
};

const cashCard = (over: Partial<ProposalView>): ProposalView =>
  proposal({ direction: "in", destination: null, auditorVerdict: "pass", ...over });

export const CASH_CARDS: ProposalView[] = [
  cashCard({
    id: id(70),
    kind: "factoring_request",
    subjectTable: "settlement_periods",
    subjectId: PERIOD_ID,
    subjectLabel: null,
    amountCents: 184_701,
    title: "Factor invoices (Test mode)",
    reasons: [reason("narrows_short"), reason("factoring_test_mode")],
    sources: [{ table: "invoices", id: INVOICE_ID }],
    cash: {
      kind: "factoring_request",
      shortCents: 680_000,
      advanceBps: 9_000,
      feeBps: 300,
      invoices: [
        { invoiceId: INVOICE_ID, invoiceNumber: "BR-INV-10244", balanceCents: 212_300, advanceCents: 191_070, feeCents: 6_369, netCents: 184_701, reserveCents: 21_230 },
      ],
    },
  }),
  cashCard({
    id: id(71),
    kind: "bill_defer",
    subjectTable: "vendor_bills",
    subjectId: BILL_ID,
    subjectLabel: "BR-NTB-2229",
    amountCents: 888_424,
    direction: "none",
    title: "Delay a vendor bill",
    reasons: [reason("bill_flexible", { table: "vendor_bills", id: BILL_ID }), reason("due_before_pay_day"), reason("covers_short")],
    sources: [{ table: "vendor_bills", id: BILL_ID }],
    cash: { kind: "bill_defer", billId: BILL_ID, billRef: "BR-NTB-2229", amountCents: 888_424, dueOn: "2026-11-06", deferredTo: "2026-11-20", shortCents: 680_000 },
  }),
  cashCard({
    id: id(72),
    kind: "collections_chase",
    subjectTable: "customers",
    subjectId: LATE_CUSTOMER_ID,
    subjectLabel: "Harbor Point Foods",
    amountCents: 2_607_400,
    title: "Chase a late payer (Test mode)",
    reasons: [reason("repeat_late_payer"), reason("past_due_balance"), reason("collections_test_mode")],
    sources: [{ table: "customers", id: LATE_CUSTOMER_ID }],
    cash: {
      kind: "collections_chase",
      overdueInvoices: 3,
      invoices: [
        { invoiceId: id(68), invoiceNumber: "BR-INV-10262", balanceCents: 182_500, dueOn: "2026-10-02" },
        { invoiceId: id(69), invoiceNumber: "BR-INV-10263", balanceCents: 2_424_900, dueOn: "2026-10-09" },
      ],
    },
  }),
  // A chase already approved in test mode: its amount line says no money moved.
  cashCard({
    id: id(73),
    kind: "collections_chase",
    subjectTable: "customers",
    subjectId: CUSTOMER_ID,
    subjectLabel: "Tanglewood Grocery Supply",
    amountCents: 182_500,
    status: "done",
    title: "Chase a late payer (Test mode)",
    reasons: [reason("past_due_balance"), reason("collections_test_mode")],
    sources: [{ table: "customers", id: CUSTOMER_ID }],
    cash: {
      kind: "collections_chase",
      overdueInvoices: 1,
      invoices: [{ invoiceId: id(66), invoiceNumber: "BR-INV-10260", balanceCents: 182_500, dueOn: "2026-10-30" }],
    },
  }),
];

export const CASH_VIEW: CashView = { check: CASH_CHECK, bills: VENDOR_BILLS, cards: CASH_CARDS };

export const CASH_HOME: CashHome = { payDay: CASH_CHECK.payDay, gapCents: CASH_CHECK.figures.gapCents, createdAt: CASH_CHECK.createdAt };

// The fuel checks page: every problem, every row status (a sent row with its card, a carried-out
// card that reads Corrected, a dismissed and a cleared row), and a duplicate whose two photos were
// compared. Each sentence comes from the page's own template, so its words are the ones a person reads.
const fuelSaid = (over: Partial<SentenceInput>): string =>
  fuelSentence({
    check: "fuel_off_route",
    driver: "Rosa Delgado",
    purchasedOn: "2026-10-29",
    state: "TN",
    gallonsMilli: 95_000,
    tankGallons: 200,
    amountCents: 36_575,
    paidWith: "company_card",
    loadNumber: "BR-L10247",
    loadStates: ["GA"],
    minutesApart: null,
    ...over,
  });

const fuelRow = (n: number, over: Partial<FuelRowView>): FuelRowView => ({
  id: id(300 + n),
  check: "fuel_off_route",
  status: "open",
  driverName: "Rosa Delgado",
  truckUnit: "BR-T107",
  purchasedOn: "2026-10-29",
  amountCents: 36_575,
  gallonsMilli: 95_000,
  tankGallons: 200,
  excessCents: null,
  suggestedCents: -36_575,
  noSuggestion: null,
  dismissCategory: null,
  purchaseRef: `br-fuel-${310 + n}`,
  otherPurchaseRef: null,
  loadId: LOAD_ID,
  loadNumber: "BR-L10247",
  payItemRef: null,
  compare: { verdict: null, confidence: null, category: null },
  photoIds: [],
  sentence: fuelSaid({}),
  proposal: null,
  ...over,
});

const fuelCard = (n: number, status: ProposalView["status"]): ProposalView =>
  proposal({
    id: id(320 + n),
    kind: "pay_correction",
    subjectLabel: "BR-D12",
    amountCents: -12_000,
    direction: "in",
    title: "Pay correction for Marcus Hale",
    reasons: [{ category: "no_load_or_day", text: reasonSentence("no_load_or_day"), source: { table: "loads", id: LOAD_ID } }],
    status,
    destination: null,
  });

export const FUEL_RUN: FuelRunView = {
  status: "done",
  checked: 464,
  found: 8,
  startedAt: "2026-11-02T16:00:00.000Z",
  finishedAt: "2026-11-02T16:00:04.000Z",
};

const FUEL_ROWS: FuelRowView[] = [
  fuelRow(1, {}),
  fuelRow(2, {
    check: "fuel_over_tank",
    driverName: "Marcus Hale",
    gallonsMilli: 286_400,
    tankGallons: 250,
    amountCents: 110_232,
    excessCents: 14_014,
    suggestedCents: null,
    noSuggestion: "over_tank",
    loadId: null,
    loadNumber: null,
    sentence: fuelSaid({ check: "fuel_over_tank", driver: "Marcus Hale", gallonsMilli: 286_400, tankGallons: 250, state: "VA" }),
  }),
  fuelRow(3, {
    check: "fuel_while_parked",
    loadId: null,
    loadNumber: null,
    suggestedCents: -24_100,
    amountCents: 24_100,
    sentence: fuelSaid({ check: "fuel_while_parked", state: "NC", loadNumber: null, loadStates: [] }),
  }),
  fuelRow(4, {
    check: "fuel_duplicate",
    driverName: "Marcus Hale",
    gallonsMilli: 84_200,
    amountCents: 31_996,
    suggestedCents: -31_996,
    otherPurchaseRef: "br-fuel-465-again",
    payItemRef: "BR-PAY-1022",
    photoIds: [id(330), id(331)],
    compare: { verdict: "same", confidence: "high", category: null },
    sentence: fuelSaid({ check: "fuel_duplicate", driver: "Marcus Hale", gallonsMilli: 84_200, amountCents: 31_996, state: "MD", minutesApart: 12 }),
  }),
  fuelRow(5, {
    check: "fuel_duplicate",
    suggestedCents: null,
    noSuggestion: "card_double_charge",
    otherPurchaseRef: "br-fuel-316-again",
    compare: { verdict: "unknown", confidence: null, category: "no_photos" },
    sentence: fuelSaid({ check: "fuel_duplicate", minutesApart: 1 }),
  }),
  fuelRow(6, { check: "fuel_while_parked", status: "proposed", driverName: "Marcus Hale", proposal: fuelCard(1, "proposed") }),
  fuelRow(7, { check: "fuel_while_parked", status: "proposed", driverName: "Marcus Hale", proposal: fuelCard(2, "done") }),
  fuelRow(8, { status: "dismissed", dismissCategory: "pump_error" }),
  fuelRow(9, { status: "cleared" }),
];

export const FUEL_PAGE: FuelPage = {
  lastRun: FUEL_RUN,
  needYou: FUEL_ROWS.filter((r) => r.status === "open").length,
  rows: FUEL_ROWS,
};

// ---- The record pages a paystub line links to: a pay item, a day driven, a weekly deduction ----

const PAYSTUB_REF = { id: id(400), periodStart: "2026-10-19", periodEnd: "2026-10-25" };
const DRIVER_REF = { id: DRIVER_ID, name: "Monique Vasquez", code: "BR-D07" };
const LOAD_REF = { table: "loads", id: LOAD_ID, label: "Load BR-L10247" };

const payItem = (over: Partial<PayItemView>): PayItemView => ({
  id: ID,
  kind: "reimbursement",
  subkind: "toll",
  amountCents: 4_500,
  itemDate: "2026-10-26",
  description: "Tolls",
  correction: false,
  driver: DRIVER_REF,
  for: { kind: "load", load: LOAD_REF },
  paidOn: null,
  ...over,
});

// Every kind a pay item can be, and every thing it can be for.
export const PAY_ITEM_CASES: [string, PayItemView][] = [
  ["tolls on a load, not paid yet", payItem({})],
  [
    "a lumper the driver paid, on a paystub",
    payItem({
      subkind: "lumper",
      amountCents: 22_500,
      description: "Lumper paid by driver",
      for: { kind: "extra_charge", load: LOAD_REF, chargeId: id(401), chargeKind: "lumper" },
      paidOn: PAYSTUB_REF,
    }),
  ],
  [
    "fuel on the company card",
    payItem({
      kind: "fuel",
      subkind: "fuel",
      amountCents: 31_996,
      description: "Fuel, company card",
      for: { kind: "fuel_purchase", purchasedOn: "2026-10-27", state: "MD", amountCents: 31_996 },
      paidOn: PAYSTUB_REF,
    }),
  ],
  [
    "a shortfall carried from last week",
    payItem({ kind: "carried_shortfall", subkind: "shortfall", amountCents: 12_000, description: "", for: { kind: "paystub", paystub: PAYSTUB_REF } }),
  ],
  [
    "a pay correction",
    payItem({ kind: "other_deduction", subkind: "correction", amountCents: 20_000, description: "Advance logged twice", correction: true, for: { kind: "correction" } }),
  ],
  [
    "a deduction tied to nothing, driver not found",
    payItem({ kind: "other_deduction", subkind: "eld_fee", amountCents: 3_500, description: "ELD subscription", driver: null, for: { kind: "none" } }),
  ],
];

const RULES: NonNullable<DriverDayView["rules"]> = { effectiveFrom: "2026-10-19", note: "Insurance rate raised", perDayCents: 1_100, appliesTo: "owner_operator" };
const driverDay = (over: Partial<DriverDayView>): DriverDayView => ({
  id: ID,
  day: "2026-10-26",
  source: "load",
  driver: DRIVER_REF,
  workerType: "owner_operator",
  ownInsurance: false,
  load: LOAD_REF,
  rules: RULES,
  ...over,
});

// Each answer the "Charged to this driver" line can give, with the words it must show.
const NOT_KNOWN = "Not known: the driver's record could not be read";
export const DRIVER_DAY_CASES: [string, DriverDayView, string][] = [
  ["a load day, charged", driverDay({}), "Yes, once for this day"],
  ["a dispatch day with no load", driverDay({ source: "dispatch", load: null, rules: { ...RULES, note: null } }), "Yes, once for this day"],
  ["a company driver, owner-operators only", driverDay({ workerType: "company" }), "No, this carrier charges insurance to owner-operators only"],
  ["the driver carries their own insurance", driverDay({ ownInsurance: true }), "No, the driver carries their own insurance"],
  ["no pay rules cover the week", driverDay({ rules: null }), "No pay rules cover this week"],
  ["the driver could not be read", driverDay({ driver: null, workerType: null, rules: { ...RULES, appliesTo: "all" } }), NOT_KNOWN],
  [
    "the driver could not be read, owner-operators only",
    driverDay({ driver: null, workerType: null, rules: { ...RULES, appliesTo: "owner_operator" } }),
    NOT_KNOWN,
  ],
];

const schedule = (over: Partial<ScheduleView>): ScheduleView => ({
  id: ID,
  kind: "escrow",
  amountCents: 10_000,
  description: "Escrow",
  activeFrom: "2026-09-07",
  activeTo: null,
  driver: DRIVER_REF,
  escrow: { balanceCents: 80_000, targetCents: 200_000 },
  ...over,
});

// Escrow (building, reached, not known), a truck lease that ends, and another weekly deduction.
export const SCHEDULE_CASES: [string, ScheduleView][] = [
  ["escrow building to its target", schedule({})],
  ["escrow at its target", schedule({ escrow: { balanceCents: 200_000, targetCents: 200_000 } })],
  ["escrow, balance and target not known", schedule({ driver: null, escrow: { balanceCents: null, targetCents: null } })],
  [
    "a truck lease with an end date",
    schedule({ kind: "lease", amountCents: 45_000, description: "Truck lease-purchase payment", activeTo: "2027-09-06", escrow: null }),
  ],
  ["another weekly deduction", schedule({ kind: "other", amountCents: 2_500, description: "Cell phone plan", escrow: null })],
];

// The help page's link to the worked week's driver: her draft paystub, or her driver page.
export const HERO_LINK_DRAFT = { href: `/records/settlements/${PAYSTUB_REF.id}`, draft: true };
export const HERO_LINK_DRIVER = { href: `/records/drivers/${DRIVER_ID}`, draft: false };
