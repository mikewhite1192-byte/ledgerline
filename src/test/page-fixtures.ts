import type { AdvanceListRow, AdvanceRecord, DriverAdvance, DriverOption } from "@/lib/advances/read";
import type { DriverIdentity } from "@/lib/advances/identity";
import type { ProposalView, TurnView } from "@/lib/agent/view";
import type { CallRow, Spend } from "@/lib/ai/spend";
import type { DaySpend, SpendAlert } from "@/lib/ai/watch";
import type { ClipView } from "@/lib/clips/types";
import type { DocumentView } from "@/lib/documents/types";
import type { DriverView, NotePeriod, PeriodNotes } from "@/lib/driver-notes/view";
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
import { noteLabel, type NoteRow, type NoteSubject } from "@/lib/memory/notes";
import type { PortalLoadDetail, PortalLoadLine } from "@/lib/portal/read";
import type { RunSummary, RunView } from "@/lib/portal/views";
import type { InvoiceReviewReason, InvoiceReviewStatus } from "@/lib/rules-engine";
import type { Cents, PayLine } from "@/lib/rules-engine/types";
import { DEMO_ANCHOR } from "@/lib/seed/anchor";
import { DEMO_CARRIERS } from "@/lib/seed/carriers";
import { buildCarrierPlan } from "@/lib/seed/plan";
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

// The Memory page: a note about a customer, one about a driver, one about the whole carrier from a
// person, one whose customer is no longer on file, and a suggestion from the chat waiting for Keep.
const memoryNote = (n: number, over: Partial<NoteRow>): NoteRow => ({
  id: id(n),
  subjectKind: "customer",
  subjectId: CUSTOMER_ID,
  subjectName: "Tanglewood Grocery Supply",
  subjectCode: "BR-C01",
  text: "Pays about 45 days after due; send the reminder a week early",
  status: "active",
  sourceKind: "seed",
  sourceTurnId: null,
  createdByKind: "seed",
  createdByEmail: null,
  createdAt: "2026-10-20T17:00:00.000Z",
  updatedAt: "2026-10-20T17:00:00.000Z",
  ...over,
});

export const NOTE_SUBJECTS: NoteSubject[] = [
  { kind: "customer", id: CUSTOMER_ID, name: "Tanglewood Grocery Supply", code: "BR-C01" },
  { kind: "driver", id: DRIVER_ID, name: "Rosa Delgado", code: "BR-D07" },
  { kind: "driver", id: id(21), name: "Marcus Hale", code: "BR-D12" },
];

export const MEMORY_NOTES: NoteRow[] = [
  memoryNote(141, {}),
  memoryNote(142, {
    subjectKind: "driver",
    subjectId: DRIVER_ID,
    subjectName: "Rosa Delgado",
    subjectCode: "BR-D07",
    text: "Takes the Charlotte runs; ask before a weekend dispatch",
    createdByKind: "person",
    createdByEmail: EMAIL,
  }),
  memoryNote(143, {
    subjectKind: "carrier",
    subjectId: null,
    subjectName: null,
    subjectCode: null,
    text: "Bill every detention charge the same week it happens",
    createdByKind: "person",
    createdByEmail: null,
    createdAt: "2026-10-22T14:30:00.000Z",
  }),
  memoryNote(144, { subjectName: null, subjectCode: null, text: "Wants the paperwork by fax, not email" }),
  memoryNote(145, {
    subjectKind: "driver",
    subjectId: id(21),
    subjectName: "Marcus Hale",
    subjectCode: "BR-D12",
    text: "Prefers a text over a call",
    status: "suggested",
    sourceKind: "chat",
    sourceTurnId: id(146),
    createdByKind: "agent",
    createdAt: "2026-10-27T15:10:00.000Z",
  }),
];

// The notes a trace says the agent read: two still on file (named as the trace names them) and one
// removed since, which the trace counts but cannot link.
export const NOTES_USED = [
  { id: MEMORY_NOTES[0].id, label: noteLabel(MEMORY_NOTES[0]) },
  { id: MEMORY_NOTES[2].id, label: noteLabel(MEMORY_NOTES[2]) },
  { id: id(147), label: null },
];
