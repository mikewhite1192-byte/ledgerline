import type { AdvanceListRow, AdvanceRecord, DriverAdvance, DriverOption } from "@/lib/advances/read";
import type { DriverIdentity } from "@/lib/advances/identity";
import type { Checklist } from "@/lib/agent/checklist";
import { reasonSentence } from "@/lib/agent/reasons";
import { stopSummary } from "@/lib/agent/stop-summary";
import type { ProposalView, RuleChangeView, TurnView } from "@/lib/agent/view";
import type { CallRow, Spend } from "@/lib/ai/spend";
import type { DaySpend, SpendAlert } from "@/lib/ai/watch";
import type { CashCheckView, CashHome, CashView, VendorBillView } from "@/lib/cash/view";
import type { ClipView } from "@/lib/clips/types";
import type { BreakView, RunView as CardRunView } from "@/lib/data/card-recon";
import type { CollectionsView, LateInvoice, ReminderCard } from "@/lib/collections/view";
import type { DocumentView } from "@/lib/documents/types";
import type { RequestDetail, RequestSummary } from "@/lib/factoring/read";
import type { DriverView, NotePeriod, PeriodNotes } from "@/lib/driver-notes/view";
import { figureValueText, profitWeek, type ClosedWeek } from "@/lib/briefs/figures";
import type { BriefRecord, ProfitView } from "@/lib/briefs/view";
import type { QuarterBody, QuarterRecord, QuarterState, QuarterView } from "@/lib/briefs/quarter-review";
import { quarterOf, type DriverRecord, type Quarter, type QuarterInput } from "@/lib/rules-engine";
import type { DriverInsightsInput } from "@/lib/reports/driver-insights";
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
import type { MoneyCodeDetail, MoneyCodeRow } from "@/lib/money-codes/read";
import type { RequestChoices } from "@/lib/money-codes/request";
import type { MoneyAction } from "@/lib/money/types";
import { noteLabel, type NoteRow, type NoteSubject } from "@/lib/memory/notes";
import type { PayRulesPage } from "@/lib/pay-rules/read";
import type { CardRow, CardSummary, PeriodCards } from "@/lib/pay-cards/read";
import { cardSpec, type CardSpec } from "@/lib/pay-cards/spec";
import { RULES as RULE_SPECS, formatValue, labelFor } from "@/lib/pay-rules/rules";
import type { PortalLoadDetail, PortalLoadLine } from "@/lib/portal/read";
import type { CardHome, HandPick } from "@/lib/recon/view";
import type { RatesPage, RateView } from "@/lib/rates/read";
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
import { endSweep, sweepChecklist, tickSweep } from "@/lib/sweep/checklist";
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

// An answer's checklist with an item in every state, and an answer a cap stopped: its text is the
// plain stop summary, then what it found.
export const CHECKLIST_EVERY_STATE: Checklist = {
  v: 1,
  by: "model",
  items: [
    { key: "m1", text: "Read Rosa's loads this week", state: "done" },
    { key: "m2", text: "Check her fuel advance limit", state: "doing" },
    { key: "m3", text: "Draft the advance for you to approve", state: "todo" },
    { key: "m4", text: "Compare with last week", state: "skipped" },
    { key: "m5", text: "Check her escrow balance", state: "not_done" },
  ],
};

const STOPPED_CHECKLIST: Checklist = {
  v: 1,
  by: "model",
  items: [
    { key: "m1", text: "Read Rosa's loads this week", state: "done" },
    { key: "m2", text: "Check her fuel advance limit", state: "not_done" },
    { key: "m3", text: "Draft the advance for you to approve", state: "not_done" },
  ],
};

export const CHECKLIST_TURNS: TurnView[] = [
  { ...TURNS[0], id: id(340), status: "running", text: "", proposals: [], checklist: CHECKLIST_EVERY_STATE },
  {
    ...TURNS[0],
    id: id(341),
    status: "partial",
    endedReason: "max_turns",
    text: `${stopSummary(STOPPED_CHECKLIST, { steps: 6 })}\n\nRosa Delgado ran 4 loads this week.`,
    proposals: [],
    checklist: STOPPED_CHECKLIST,
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
  left: 0,
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
  checklist: endSweep(tickSweep(tickSweep(tickSweep(tickSweep(sweepChecklist(true), "plan"), "check"), "draft"), "audit"), "done"),
};

// A run its budget stopped while drafting, and a run that skipped the second look.
export const SWEEP_RUN_STOPPED: SweepRunView = {
  ...SWEEP_RUN,
  truncatedReason: "cap",
  checklist: endSweep(tickSweep(sweepChecklist(true), "draft"), "stopped"),
};
// A run that reached its turn ceiling while drafting: what it drafted was audited, and the rest
// wait for the next sweep.
export const SWEEP_RUN_MAX_TURNS: SweepRunView = {
  ...SWEEP_RUN,
  truncatedReason: "max_turns",
  turnsUsed: 30,
  checklist: endSweep(tickSweep(tickSweep(sweepChecklist(false), "draft"), "audit"), "stopped", { stoppedAfter: "audit" }),
};
export const SWEEP_RUN_RUNNING: SweepRunView = {
  ...SWEEP_RUN,
  status: "running",
  phase: "check",
  finishedAt: null,
  checklist: tickSweep(tickSweep(sweepChecklist(true), "plan"), "check"),
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
    parkReason: null,
    parkedAt: null,
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
  markup: { status: "none", attemptsLeft: 3, category: null, at: null, stalled: false, eligibility: "eligible" },
  crop: { status: "none", method: null, category: null, confidence: null, quad: null, box: null, at: null },
  ...over,
});

export const DOCUMENTS: DocumentView[] = [
  document({}),
  document({ id: id(111), filename: "rate-con.pdf", mime: "application/pdf", readStatus: "pending", kind: null, read: null, match: null, readCallId: null }),
  document({ id: id(112), filename: "blurry.png", mime: "image/png", readStatus: "unreadable", kind: null, read: null, match: { found: false, reason: "unreadable" }, readAttempts: 3 }),
  document({ id: id(113), filename: "late.webp", mime: "image/webp", readStatus: "budget", kind: null, read: null, match: null }),
];

// The document page's marked copy block, one per state the block shows.
const markup = (over: Partial<DocumentView["markup"]>): DocumentView["markup"] => ({
  status: "none",
  attemptsLeft: 3,
  category: null,
  at: null,
  stalled: false,
  eligibility: "eligible",
  ...over,
});

export const MARKUP_DOCUMENTS: { name: string; view: DocumentView }[] = [
  { name: "eligible", view: document({}) },
  { name: "marking", view: document({ markup: markup({ status: "marking", attemptsLeft: 2, at: "2026-10-28T15:05:00.000Z" }) }) },
  { name: "checked", view: document({ markup: markup({ status: "checked", attemptsLeft: 2, at: "2026-10-28T15:05:00.000Z" }) }) },
  { name: "mismatch", view: document({ markup: markup({ status: "mismatch", attemptsLeft: 2, category: "callout_wrong", at: "2026-10-28T15:05:00.000Z" }) }) },
  { name: "mismatch, no tries left", view: document({ markup: markup({ status: "mismatch", attemptsLeft: 0, category: "extra_amount", at: "2026-10-28T15:05:00.000Z" }) }) },
  { name: "waiting for budget", view: document({ markup: markup({ status: "unavailable", category: "budget" }) }) },
  { name: "timed out", view: document({ markup: markup({ status: "unavailable", attemptsLeft: 1, category: "timeout", at: "2026-10-28T15:05:00.000Z" }) }) },
  { name: "agrees", view: document({ markup: markup({ eligibility: "agrees" }) }) },
  { name: "no line to circle", view: document({ markup: markup({ eligibility: "no_anchor_line" }) }) },
  { name: "pdf", view: document({ id: id(114), filename: "rate-con.pdf", mime: "application/pdf", markup: markup({ eligibility: "not_image" }) }) },
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
  resumeAttempts: 0,
  resumed: null,
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

// The pay cards page for the settled week: one row in each state a clerk meets. Every card's
// figures come from the seed's own paystub through cardSpec, as the page's read works them out.
const cardSpecFor = (settlementId: string, driverId: string, firstName: string, language: "en" | "es"): CardSpec => {
  const spec = cardSpec({
    carrierName: TENANT.name,
    settlement: { ...settled.settlement, id: settlementId, status: "approved" },
    period: settled.period,
    driver: { id: driverId, first_name: firstName, preferred_language: language },
    lines: settled.lines,
    previousNetCents: settled.settlement.net_cents - 4_000,
    previousLines: [...settled.lines.map((l) => ({ kind: l.kind, amount_cents: l.amount_cents })), { kind: "reimbursement", amount_cents: -4_000 }],
  });
  if (!spec) throw new Error("the fixture paystub gives no pay card");
  return spec;
};

const cardTry = (n: number, attempt: number, status: CardSummary["status"], category: CardSummary["category"], spec: unknown): CardSummary => ({
  id: id(n),
  attempt,
  status,
  category,
  spec,
});

const cardRow = (n: number, name: string, language: "en" | "es", row: Omit<CardRow, "settlementId" | "driverName" | "driverCode" | "spec">): CardRow => {
  const settlementId = n === 660 ? settled.settlement.id : id(n);
  const [first] = name.split(" ");
  return {
    settlementId,
    driverName: name,
    driverCode: `BR-D${String(n - 640).padStart(2, "0")}`,
    spec: cardSpecFor(settlementId, n === 660 ? settled.driver.id : id(n + 300), first, language),
    ...row,
  };
};

export const PERIOD_CARDS: PeriodCards = {
  period: { id: settled.period.id, periodStart: settled.period.period_start, periodEnd: settled.period.period_end },
  rows: [
    cardRow(660, `${settled.driver.first_name} ${settled.driver.last_name}`, "en", {
      latest: cardTry(670, 1, "checked", null, {}),
      checkedId: id(670),
      attemptsUsed: 1,
      pill: "checked",
      reason: null,
    }),
    cardRow(662, "Marcus Hale", "es", { latest: null, checkedId: null, attemptsUsed: 0, pill: "none", reason: null }),
    cardRow(664, "Dana Whitfield", "en", {
      latest: cardTry(671, 1, "mismatch", "number_mismatch", {}),
      checkedId: null,
      attemptsUsed: 1,
      pill: "mismatch",
      reason: "number_mismatch",
    }),
    cardRow(666, "Luis Romero", "es", {
      latest: cardTry(672, 2, "mismatch", "text_mismatch", {}),
      checkedId: null,
      attemptsUsed: 2,
      pill: "mismatch",
      reason: "text_mismatch",
    }),
    cardRow(668, "Priya Nair", "en", {
      latest: cardTry(673, 1, "unavailable", "timeout", {}),
      checkedId: null,
      attemptsUsed: 1,
      pill: "unavailable",
      reason: "timeout",
    }),
    cardRow(674, "Owen Brooks", "en", {
      latest: cardTry(675, 1, "unavailable", "budget", {}),
      checkedId: null,
      attemptsUsed: 1,
      pill: "budget",
      reason: "budget",
    }),
    cardRow(676, "Tessa Lund", "en", {
      latest: cardTry(677, 1, "checked", null, {}),
      checkedId: null,
      attemptsUsed: 1,
      pill: "stale",
      reason: null,
    }),
    cardRow(678, "Caleb Ortiz", "en", {
      latest: cardTry(679, 1, "checking", null, {}),
      checkedId: null,
      attemptsUsed: 1,
      pill: "checking",
      reason: null,
    }),
    cardRow(680, "Nora Vance", "en", {
      latest: cardTry(681, 3, "unavailable", "off_schema", {}),
      checkedId: null,
      attemptsUsed: 3,
      pill: "unavailable",
      reason: "off_schema",
    }),
  ],
};

// The checked card the driver's view shows above the note.
export const DRIVER_CARD = { id: id(670), art: PERIOD_CARDS.rows[0].spec.art };

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

// Money codes: one of each state a person can see, the detail of an issued lumper code (its two
// paystub lines and the invoice line), the request form's choices and a request waiting for
// approval. The live code expires far in the future so the page shows Show code, not "expired".
const codeRow = (n: number, over: Partial<MoneyCodeRow>): MoneyCodeRow => ({
  id: id(300 + n),
  driverId: DRIVER_ID,
  driverName: "Rosa Delgado",
  driverCode: "BR-D07",
  loadId: LOAD_ID,
  loadNumber: "BR-L10247",
  purpose: "lumper",
  amountCents: 15_000,
  sourceKind: "document",
  documentId: id(320),
  voiceNoteId: null,
  receiptTotalCents: 15_000,
  proposalId: id(321),
  moneyActionId: id(322),
  status: "issued",
  codeLast4: "4821",
  accessorialId: id(323),
  chargeItemId: id(324),
  reimbursementItemId: id(325),
  issuedAt: "2026-10-28T15:10:00.000Z",
  expiresAt: "2099-10-30T15:10:00.000Z",
  createdAt: "2026-10-28T15:00:00.000Z",
  ...over,
});

export const MONEY_CODES: MoneyCodeRow[] = [
  codeRow(1, {}),
  codeRow(2, { purpose: "repair", amountCents: 42_099, status: "failed", codeLast4: null, accessorialId: null, chargeItemId: null, reimbursementItemId: null, issuedAt: null, expiresAt: null }),
  codeRow(3, { purpose: "other", amountCents: 9_998, status: "unknown", codeLast4: null, accessorialId: null, chargeItemId: null, reimbursementItemId: null, issuedAt: null, expiresAt: null, sourceKind: "form", documentId: null, receiptTotalCents: null }),
  codeRow(4, { status: "issuing", codeLast4: null, accessorialId: null, chargeItemId: null, reimbursementItemId: null, issuedAt: null, expiresAt: null }),
  codeRow(5, { status: "issued", expiresAt: "2026-10-30T15:10:00.000Z" }),
];

const codeAction = (over: Partial<MoneyAction>): MoneyAction => ({
  id: id(322),
  tenantId: ID,
  kind: "money_code_issue",
  channel: "payment",
  subjectTable: "money_codes",
  subjectId: id(301),
  attempt: 1,
  idempotencyKey: "money_code_issue:test:1",
  requestId: id(326),
  amountCents: 15_000,
  counterpartyTable: "drivers",
  counterpartyId: DRIVER_ID,
  state: "confirmed",
  failureCategory: null,
  settledVia: "response",
  outsideSystem: "fuel_card_sim",
  outsideType: "money_code",
  // The simulated card provider's reference shape: fcs_code_ and 24 hex.
  outsideId: "fcs_code_7c41e2a9b30d5f18a6e4c2b9",
  outsideRef: null,
  outsideAmountCents: 15_000,
  proposedBy: "agent",
  proposalId: id(321),
  traceId: null,
  approverMembershipId: MEMBER_ID,
  batchId: null,
  checkCount: 0,
  createdAt: "2026-10-28T15:09:00.000Z",
  sentAt: "2026-10-28T15:09:01.000Z",
  settledAt: "2026-10-28T15:10:00.000Z",
  lastCheckedAt: null,
  sentSecondsAgo: 60,
  ...over,
});

export const MONEY_CODE_DETAIL: MoneyCodeDetail = {
  code: MONEY_CODES[0],
  // As stored: the charge is an other_deduction pay item of +$150.00, the reimbursement +$150.00.
  charge: { id: id(324), label: "Charge", amountCents: 15_000, itemDate: "2026-10-28" },
  reimbursement: { id: id(325), label: "Reimbursement", amountCents: 15_000, itemDate: "2026-10-28" },
  accessorial: { id: id(323), amountCents: 15_000, description: "Lumper" },
  receipt: { id: id(320), filename: "lumper-receipt.webp", isImage: true },
  settlementId: id(327),
  actions: [codeAction({})],
};

export const MONEY_CODE_UNKNOWN: MoneyCodeDetail = {
  code: MONEY_CODES[2],
  charge: null,
  reimbursement: null,
  accessorial: null,
  receipt: null,
  settlementId: null,
  actions: [codeAction({ id: id(328), subjectId: id(303), amountCents: 9_998, state: "unknown", failureCategory: "timeout", settledVia: null, outsideId: null, outsideAmountCents: null, settledAt: null })],
};

export const MONEY_CODE_FAILED: MoneyCodeDetail = {
  code: MONEY_CODES[1],
  charge: null,
  reimbursement: null,
  accessorial: null,
  receipt: { id: id(329), filename: "repair-invoice.pdf", isImage: false },
  settlementId: null,
  actions: [codeAction({ id: id(340), subjectId: id(302), amountCents: 42_099, state: "failed", failureCategory: "declined", settledVia: "response", outsideId: null, outsideAmountCents: null })],
};

export const CODE_CHOICES: RequestChoices = {
  loads: [
    { id: LOAD_ID, loadNumber: "BR-L10247", driverCode: "BR-D07", driverName: "Rosa Delgado", status: "in_transit" },
    { id: id(341), loadNumber: "BR-L10251", driverCode: "BR-D12", driverName: "Marcus Hale", status: "delivered" },
  ],
  receipts: [{ id: id(320), filename: "lumper-receipt.webp", kind: "lumper_receipt" }],
};

export const CODE_PROPOSALS: ProposalView[] = [
  proposal({
    id: id(342),
    kind: "money_code",
    subjectTable: "loads",
    subjectId: LOAD_ID,
    subjectLabel: "BR-L10247",
    amountCents: 15_000,
    direction: "out",
    title: "Lumper code for Rosa Delgado on BR-L10247",
    destination: null,
  }),
];

// The collections page: late invoices with no reminder yet (more than the list names, so "and N
// more" shows) and a reminder in every state, approved both ways. A refused reminder has no draft.
const lateInvoice = (n: number, over: Partial<LateInvoice> = {}): LateInvoice => ({
  invoiceId: id(200 + n),
  customerId: CUSTOMER_ID,
  customerName: "Tanglewood Grocery Supply",
  invoiceNumber: `BR-INV-102${String(n).padStart(2, "0")}`,
  daysLate: 31 + n,
  balanceCents: 182_500,
  dueOn: "2026-09-25",
  stage: "30",
  tone: "friendly",
  ...over,
});

export const reminderCard = (n: number, over: Partial<ReminderCard> = {}): ReminderCard => ({
  id: id(250 + n),
  invoiceId: id(230 + n),
  customerId: CUSTOMER_ID,
  customerName: "Tanglewood Grocery Supply",
  invoiceNumber: `BR-INV-103${String(n).padStart(2, "0")}`,
  stage: "60",
  tone: "direct",
  status: "drafted",
  daysLate: 64,
  balanceCents: 245_000,
  dueOn: "2026-08-24",
  subject: `Invoice BR-INV-103${String(n).padStart(2, "0")} is 64 days past due`,
  body: "Hello,\n\nInvoice BR-INV-10301 for $2,450.00 was due on Aug 24, 2026 and is now 64 days past due. Please send payment or reply with a date we can expect it.\n\nThank you,\nBlue Ridge Freight",
  refusalCategory: null,
  channel: null,
  sentAt: null,
  ...over,
});

export const COLLECTIONS_VIEW: CollectionsView = {
  asOf: "2026-10-27",
  timezone: TENANT.timezone,
  pastDueCount: 12,
  pastDueCents: 2_604_000,
  waiting: 3,
  approvedLastWeek: 2,
  toDraft: [
    lateInvoice(1),
    lateInvoice(2, { customerName: "Harbor Point Lumber", tone: "direct" }),
    lateInvoice(3, { stage: "60", daysLate: 61, tone: "firm" }),
    lateInvoice(4, { stage: "90", daysLate: 95 }),
    lateInvoice(5),
    lateInvoice(6),
  ],
  cards: [
    reminderCard(1),
    reminderCard(2, { tone: "friendly", stage: "30", daysLate: 33 }),
    reminderCard(3, { tone: "firm", stage: "90", daysLate: 97 }),
    reminderCard(4, { status: "drafting", subject: null, body: null }),
    reminderCard(5, { status: "over_cap", subject: null, body: null }),
    reminderCard(6, { status: "refused", subject: null, body: null, refusalCategory: "number_mismatch" }),
    reminderCard(7, { status: "approved", channel: "logged" }),
    reminderCard(8, { status: "approved", channel: "email", sentAt: "2026-10-27T15:05:00.000Z" }),
    reminderCard(9, { status: "approved", channel: "email" }),
    reminderCard(10, { status: "rejected" }),
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

// ---- The quarter review: a quarter so far counted by the real engine, and its review in each state ----

const QUARTER_PERIOD = { start: "2026-10-01", end: "2026-12-31" };
const QUARTER_AS_OF = "2026-11-02";
const SECOND_DRIVER_ID = id(472);
const quarterCustomer = (cid: string, code: string, name: string) => ({
  id: cid,
  code,
  name,
  termsDays: 30,
  city: "Roanoke",
  state: "VA",
  detentionFreeMinutes: 120,
  detentionHourlyCents: 7_500 as Cents,
});
const quarterStub = (n: number, periodId: string, driverId: string, netCents: number, exceptionCount = 0) => ({
  id: id(n),
  periodId,
  driverId,
  status: "paid" as const,
  grossCents: (netCents + 30_000) as Cents,
  deductionsCents: 30_000 as Cents,
  netCents: netCents as Cents,
  carryForwardCents: 0 as Cents,
  exceptionCount,
  paidAt: null,
});
const quarterInvoice = (n: number, customerId: string, amountCents: number, issuedOn: string, status: "open" | "paid") => ({
  id: id(n),
  source: "load" as const,
  loadId: id(n - 62),
  customerId,
  invoiceNumber: `BR-INV-10${n}`,
  amountCents: amountCents as Cents,
  issuedOn,
  dueOn: "2026-11-30",
  status,
  paidOn: status === "paid" ? "2026-10-28" : null,
  qboId: null,
});
const QUARTER_INPUT: QuarterInput = {
  periods: [
    { id: id(460), periodStart: "2026-10-05", periodEnd: "2026-10-11", status: "paid" },
    { id: id(461), periodStart: "2026-10-12", periodEnd: "2026-10-18", status: "paid" },
    { id: id(462), periodStart: "2026-10-19", periodEnd: "2026-10-25", status: "approved" },
    { id: id(463), periodStart: "2026-10-26", periodEnd: "2026-11-01", status: "open" },
  ],
  settlements: [
    quarterStub(464, id(460), DRIVER_ID, 182_500),
    quarterStub(465, id(460), SECOND_DRIVER_ID, 154_000, 1),
    quarterStub(466, id(461), DRIVER_ID, 176_250),
    quarterStub(467, id(461), SECOND_DRIVER_ID, 149_800),
    quarterStub(468, id(462), DRIVER_ID, 171_000, 2),
    quarterStub(469, id(462), SECOND_DRIVER_ID, 158_300),
    quarterStub(470, id(463), DRIVER_ID, 120_000),
  ],
  // An advance taken back from pay: a deduction, written below zero.
  lines: [{ settlementId: id(464), kind: "advance_recovery", amountCents: -10_000 }],
  drivers: [
    { id: DRIVER_ID, name: "Rosa Delgado" },
    { id: SECOND_DRIVER_ID, name: "Tom Avery" },
  ],
  customers: [
    quarterCustomer(CUSTOMER_ID, "TGS", "Tanglewood Grocery Supply"),
    quarterCustomer(PIEDMONT_ID, "PPC", "Piedmont Paper Co"),
  ],
  margin: PROFIT_LINES.map((l) => ({ ...l, deliveredOn: "2026-10-22" })),
  receivables: {
    invoices: [
      quarterInvoice(473, CUSTOMER_ID, 185_000, "2026-10-06", "paid"),
      quarterInvoice(474, CUSTOMER_ID, 142_000, "2026-10-13", "open"),
      quarterInvoice(475, PIEDMONT_ID, 176_000, "2026-09-20", "open"),
    ],
    payments: [
      {
        id: id(476),
        customerId: CUSTOMER_ID,
        receivedOn: "2026-10-28",
        amountCents: 185_000 as Cents,
        method: "ach",
        paymentRef: "ACH-55120",
        source: "seed",
        memo: null,
        qboId: null,
      },
    ],
    applications: [{ id: id(478), paymentId: id(476), invoiceId: id(473), amountCents: 185_000 as Cents }],
    asOf: QUARTER_AS_OF,
  },
  loads: [],
  accessorials: [],
  proposals: [
    { id: id(479), kind: "pay_correction", status: "done", direction: "in", amountCents: 2_500, createdOn: "2026-10-19", decidedOn: "2026-10-20" },
    { id: id(480), kind: "detention_charge", status: "done", direction: "in", amountCents: 18_750, createdOn: "2026-10-14", decidedOn: "2026-10-15" },
    { id: id(481), kind: "advance_payout", status: "proposed", direction: "out", amountCents: 10_000, createdOn: "2026-10-31", decidedOn: null },
    { id: id(482), kind: "invoice_fix", status: "rejected", direction: "in", amountCents: 100, createdOn: "2026-10-21", decidedOn: "2026-10-21" },
  ],
  detention: [
    { id: id(483), loadId: id(411), amountCents: 18_750, proposalId: id(480), proposalStatus: "done", decidedOn: "2026-10-15" },
  ],
};
export const QUARTER: Quarter = quarterOf(QUARTER_INPUT, QUARTER_PERIOD, QUARTER_AS_OF);
// Nothing happened yet this quarter: no pay run, load, invoice or payment.
export const QUARTER_EMPTY: Quarter = quarterOf(
  {
    ...QUARTER_INPUT,
    periods: [],
    settlements: [],
    lines: [],
    margin: [],
    receivables: { invoices: [], payments: [], applications: [], asOf: QUARTER_AS_OF },
    proposals: [],
    detention: [],
  },
  QUARTER_PERIOD,
  QUARTER_AS_OF,
);

// The review's lists, built from the figures so the number check passes and every number links.
const quote = (label: string): string => {
  const figure = QUARTER.figures.find((f) => f.label === label);
  if (!figure) throw new Error(`no figure ${label}`);
  return `${figureValueText(figure)} [${figure.key}]`;
};
export const QUARTER_BODY: QuarterBody = {
  went_well: [
    `Margin on priced loads was ${quote("Margin on priced loads")}, or ${quote("Margin as a share of revenue")} of revenue.`,
    `Payments received so far came to ${quote("Payments received")}.`,
  ],
  problems: [`Paystubs with a problem so far: ${quote("Paystubs with a problem")}.`],
  recovered: [
    `Detention recovered came to ${quote("Detention recovered")}, and advances recovered from pay to ${quote("Advances recovered from pay")}.`,
  ],
  change: [
    `Collect the open receivables past due, ${quote("Open receivables past due")}.`,
    `Decide the fixes waiting for a decision: ${quote("Fixes waiting for a decision")}.`,
    `Ask Piedmont Paper Co about its open balance of ${quote("Customer Piedmont Paper Co: open balance")}.`,
  ],
};

export const QUARTER_REVIEW: QuarterRecord = {
  id: id(484),
  status: "drafted",
  quarterStart: QUARTER_PERIOD.start,
  quarterEnd: QUARTER_PERIOD.end,
  asOf: QUARTER_AS_OF,
  figures: QUARTER.figures,
  body: QUARTER_BODY,
  category: null,
  updatedAt: "2026-11-02T15:00:00.000Z",
};

export const quarterView = (review: QuarterState, over: Partial<QuarterView> = {}): QuarterView => ({
  quarter: QUARTER,
  packed: QUARTER.figures,
  review,
  ...over,
});

export const QUARTER_VIEW = quarterView({ kind: "none" });

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

// ---- The card check: one check, every kind of difference, and a match card ----

const CARD_TXN_ID = id(300);

export const CARD_RUN: CardRunView = {
  id: id(301),
  status: "done",
  phase: "done",
  failCategory: null,
  windowFrom: "2026-10-16",
  windowTo: "2026-10-29",
  counts: { statement: 168, records: 42, recordsClean: 31, needsYou: 10, notConfirmed: 1 },
  unchecked: [
    { system: "stripe_test", category: "not_connected" },
    { system: "accounting", category: "timeout" },
    { system: "payment_records", category: "too_many_records" },
    { system: "fuel_card_sim", category: "read_failed" },
  ],
  modelCents: 2,
  startedAt: "2026-10-29T15:00:00.000Z",
  finishedAt: "2026-10-29T15:00:20.000Z",
};

const fuelTxn = (n: number, over: Partial<NonNullable<BreakView["transaction"]>> = {}): NonNullable<BreakView["transaction"]> => ({
  id: id(310 + n),
  kind: "fuel",
  last4: "4417",
  portalName: "TEST FUEL STOP 12",
  postedOn: "2026-10-27",
  state: "OK",
  gallonsMilli: 112_400,
  amountCents: 21_250,
  ...over,
});

const cardBreak = (n: number, over: Partial<BreakView>): BreakView => ({
  id: id(330 + n),
  category: "fuel_amount_differs",
  severity: "medium",
  outsideSystem: "fuel_card_sim",
  fixKind: "by_hand",
  status: "open",
  dismissCategory: null,
  ourCents: null,
  outsideCents: null,
  explanation: null,
  proposalId: null,
  transaction: null,
  record: null,
  purchaseId: null,
  driver: null,
  firstSeenAt: "2026-10-29T15:00:10.000Z",
  updatedAt: "2026-10-29T15:00:10.000Z",
  ...over,
});

const moneyRecord = (n: number, kind: string, subjectTable: string, subjectId: string, state = "confirmed") => ({
  id: id(350 + n),
  kind,
  subjectTable,
  subjectId,
  state,
});

export const CARD_BREAKS: BreakView[] = [
  cardBreak(1, {
    category: "card_unknown",
    severity: "high",
    fixKind: "card_match",
    proposalId: id(360),
    outsideCents: 18_040,
    transaction: { ...fuelTxn(1, { last4: "7781", amountCents: 18_040 }), id: CARD_TXN_ID },
  }),
  cardBreak(2, {
    category: "card_unknown",
    severity: "high",
    fixKind: "card_match",
    outsideCents: 9_900,
    transaction: fuelTxn(2, { last4: "7790", portalName: "POOL CARD 4", state: "TX", amountCents: 9_900 }),
  }),
  cardBreak(3, {
    category: "fuel_amount_differs",
    ourCents: 21_240,
    outsideCents: 21_250,
    explanation: "The card provider shows $212.50 for fuel on Oct 27, 2026; the fuel purchase on file is $212.40.",
    transaction: fuelTxn(3),
    purchaseId: id(370),
    driver: { id: DRIVER_ID, code: "BR-D07" },
  }),
  cardBreak(4, {
    category: "purchase_not_recorded",
    outsideCents: 15_675,
    transaction: fuelTxn(4, { amountCents: 15_675, gallonsMilli: null, state: null }),
    driver: { id: DRIVER_ID, code: "BR-D07" },
  }),
  cardBreak(5, {
    category: "load_not_in_ledger",
    severity: "high",
    outsideCents: 10_000,
    transaction: fuelTxn(5, { kind: "load", amountCents: 10_000, gallonsMilli: null }),
    driver: { id: DRIVER_ID, code: "BR-D07" },
  }),
  cardBreak(6, {
    category: "load_amount_differs",
    severity: "high",
    ourCents: 10_000,
    outsideCents: 15_000,
    transaction: fuelTxn(6, { kind: "load", amountCents: 15_000, gallonsMilli: null }),
    record: moneyRecord(1, "advance_payout", "advances", id(380)),
    driver: { id: DRIVER_ID, code: "BR-D07" },
  }),
  cardBreak(7, {
    category: "missing_outside",
    severity: "high",
    outsideSystem: "stripe_test",
    fixKind: "retry",
    ourCents: 96_975,
    record: moneyRecord(2, "settlement_payout", "settlements", id(381)),
  }),
  cardBreak(8, {
    category: "reversed_outside",
    severity: "high",
    fixKind: "by_hand",
    ourCents: 25_000,
    outsideCents: 25_000,
    record: moneyRecord(3, "advance_payout", "advances", id(382)),
  }),
  cardBreak(9, {
    category: "amount_differs_outside",
    severity: "high",
    outsideSystem: "qbo_sandbox",
    ourCents: 182_500,
    outsideCents: 180_000,
    record: moneyRecord(4, "invoice", "invoices", INVOICE_ID),
  }),
  cardBreak(10, {
    category: "pending_outside",
    severity: "low",
    outsideSystem: "qbo_sandbox",
    fixKind: "check_pending",
    ourCents: 50_000,
    record: moneyRecord(5, "customer_payment", "customer_payments", PAYMENT_ID),
  }),
  cardBreak(11, {
    category: "not_confirmed",
    severity: "medium",
    outsideSystem: null,
    fixKind: "check_pending",
    ourCents: 10_000,
    record: moneyRecord(6, "settlement_bill", "settlements", id(383), "unknown"),
  }),
];

export const CARD_HOME: CardHome = { run: CARD_RUN, breaks: CARD_BREAKS, open: { needsYou: 10, notConfirmed: 1 } };

// The match card the first difference waits on.
export const CARD_MATCH_PROPOSAL: ProposalView = proposal({
  id: id(360),
  kind: "card_match",
  subjectTable: "card_transactions",
  subjectId: CARD_TXN_ID,
  subjectLabel: "card ending 7781",
  amountCents: 18_040,
  direction: "none",
  title: "Match a card to a driver",
  reasons: [
    { category: "on_load_in_state", text: "The driver was on a load in that state that day or the day next to it.", source: { table: "loads", id: LOAD_ID } },
    { category: "holds_pool_card", text: "The driver already holds another card with the same pool name.", source: null },
  ],
  sources: [
    { table: "card_transactions", id: CARD_TXN_ID },
    { table: "drivers", id: DRIVER_ID },
    { table: "loads", id: LOAD_ID },
  ],
  operatorVerdict: "match_picked",
  destination: null,
  cardMatch: { last4: "7781", portalName: "TEST FUEL STOP 12", postedOn: "2026-10-27", state: "OK", driverCode: "BR-D07", others: ["BR-D12"] },
});

// The list a card on no driver's file shows when no match card was made: two drivers tied at the
// top on a load through the card's state, and a third who only worked that day.
export const CARD_HAND_PICK: HandPick = {
  why: "tied",
  candidates: [
    {
      driverId: DRIVER_ID,
      code: "BR-D07",
      score: 3,
      reasons: ["on_load_in_state"],
      evidence: [
        { day: "2026-10-26", loadId: LOAD_ID },
        { day: "2026-10-27", loadId: LOAD_ID },
      ],
    },
    { driverId: id(391), code: "BR-D12", score: 3, reasons: ["on_load_in_state"], evidence: [{ day: "2026-10-27", loadId: id(392) }] },
    { driverId: id(393), code: "BR-D15", score: 2, reasons: ["worked_that_day"], evidence: [{ day: "2026-10-28", loadId: null }] },
  ],
};

// The Pay rules page: the seed's versions, a later one saved from a chat, and one replaced before
// its first week began (it never ran), with the cards waiting to be saved: one checked, one with a
// question, one not checked yet, one the check stopped, one from a flagged message, one being
// saved, and one over the admin amount. The notes are written the way a save writes them.
export const NEXT_START = "2026-11-02";
const ruleNote = (key: "insurance_per_day_cents" | "net_pay_floor_cents", from: number, to: number) =>
  `${labelFor(key, "owner_operator")} to ${formatValue(RULE_SPECS[key], to)} (from ${formatValue(RULE_SPECS[key], from)})`;
const seedVersions = plan.rows.pay_configs;
const newestSeed = seedVersions[seedVersions.length - 1];
const SAVED_VERSION = id(400);
export const PAY_RULES_PAGE: PayRulesPage = {
  timeZone: TENANT.timezone,
  nextStart: NEXT_START,
  versions: [
    ...seedVersions.map((v, n) => ({ ...v, weeksPaid: n === 0 ? 2 : 1, firstWeek: v.effective_from })),
    {
      ...newestSeed,
      id: id(401),
      effective_from: "2026-10-28",
      note: ruleNote("net_pay_floor_cents", newestSeed.net_pay_floor_cents, 35_000),
      source: "ui",
      net_pay_floor_cents: 35_000,
      weeksPaid: 0,
      firstWeek: null,
    },
    {
      ...newestSeed,
      id: SAVED_VERSION,
      effective_from: "2026-10-26",
      note: ruleNote("insurance_per_day_cents", newestSeed.insurance_per_day_cents, 1_200),
      source: "proposal",
      insurance_per_day_cents: 1_200,
      weeksPaid: 0,
      firstWeek: "2026-10-26",
    },
  ],
  currentId: SAVED_VERSION,
  role: "admin",
};

const ruleChange = (over: Partial<RuleChangeView> = {}): RuleChangeView => ({
  ruleKey: "insurance_per_day_cents",
  oldValue: 1_100,
  newValue: 1_200,
  askedFrom: "2026-11-04",
  effectiveFrom: "2026-11-09",
  snapped: true,
  applied: "new_version",
  appliesTo: "owner_operator",
  impact: {
    basis: "settled_week",
    periodId: settled.period.id,
    periodStart: "2026-10-19",
    periodEnd: "2026-10-25",
    driversCompared: 25,
    driversChanged: 4,
    netDeltaCents: -2_400,
    ownerOperatorsOnly: true,
    top: [
      { driverId: DRIVER_ID, code: "BR-D07", deltaCents: -700, settlementId: id(410) },
      { driverId: id(21), code: "BR-D12", deltaCents: -600, settlementId: id(411) },
    ],
  },
  ...over,
});

const ruleCard = (n: number, over: Partial<ProposalView>): ProposalView =>
  proposal({
    id: id(420 + n),
    kind: "pay_rule_change",
    subjectTable: "pay_configs",
    subjectId: SAVED_VERSION,
    subjectLabel: "2026-10-26",
    amountCents: 2_400,
    direction: "none",
    title: "Change a pay rule",
    reasons: [{ category: "rule_change_sized_by_engine", text: reasonSentence("rule_change_sized_by_engine"), source: null }],
    sources: [],
    destination: null,
    ruleChange: ruleChange(),
    ...over,
  });

export const RULE_CHANGES: ProposalView[] = [
  ruleCard(1, {}),
  ruleCard(2, { auditorVerdict: "concerns", auditorConcerns: ["amount_high"] }),
  ruleCard(3, {
    auditorVerdict: null,
    auditorCheckedAt: null,
    ruleChange: ruleChange({ ruleKey: "net_pay_floor_cents", oldValue: 30_000, newValue: 35_000, snapped: false, askedFrom: "2026-11-09", impact: { ...ruleChange().impact, ownerOperatorsOnly: false, driversChanged: 1, netDeltaCents: 4_100, top: [{ driverId: DRIVER_ID, code: "BR-D07", deltaCents: 4_100, settlementId: id(410) }] } }),
  }),
  ruleCard(4, { auditorVerdict: "block", auditorConcerns: ["evidence_missing"] }),
  ruleCard(5, { flagged: true, flagCategories: ["instruction_like"] }),
  ruleCard(6, {
    status: "approved",
    ruleChange: ruleChange({ ruleKey: "advance_fee_cents", oldValue: 500, newValue: 0, appliesTo: "owner_operator", impact: { ...ruleChange().impact, basis: "advances_only", periodId: null, periodStart: null, periodEnd: null, driversChanged: 0, netDeltaCents: 0, top: [] } }),
  }),
  ruleCard(7, {
    amountCents: 250_000,
    ruleChange: ruleChange({ ruleKey: "insurance_applies_to", oldValue: "owner_operator", newValue: "all", impact: { ...ruleChange().impact, ownerOperatorsOnly: false, driversChanged: 21, netDeltaCents: -250_000 } }),
  }),
];

// The same change in every state a card can end in, for the chat, which shows decided cards too,
// and one that cannot be read back whole (its title and amount only), and one with no paid week.
export const RULE_CHANGES_DECIDED: ProposalView[] = [
  ruleCard(10, { status: "executing" }),
  ruleCard(11, { status: "done" }),
  ruleCard(12, { status: "failed" }),
  ruleCard(13, { status: "rejected" }),
  ruleCard(14, { status: "expired" }),
  ruleCard(15, { status: "unknown" }),
  ruleCard(16, { ruleChange: null }),
  ruleCard(17, { status: "done", ruleChange: null }),
  ruleCard(18, {
    ruleChange: ruleChange({ impact: { ...ruleChange().impact, basis: "no_settled_week", periodId: null, periodStart: null, periodEnd: null, driversChanged: 0, netDeltaCents: 0, top: [] } }),
  }),
  ruleCard(19, { ruleChange: ruleChange({ impact: { ...ruleChange().impact, driversChanged: 0, netDeltaCents: 0, top: [] } }) }),
];

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
// ---- Factoring (Test mode) ----

const FACTORING_REQUEST_ID = id(530);
const FACTORING_DOC_RC = id(531);
const FACTORING_DOC_BOL = id(532);

const factoringRequest = (over: Partial<RequestSummary>): RequestSummary => ({
  id: FACTORING_REQUEST_ID,
  createdAt: "2026-11-02T15:20:00.000Z",
  invoiceCount: 3,
  balanceCents: 645_000,
  advanceCents: 580_500,
  feeCents: 19_350,
  netCents: 561_150,
  reserveCents: 64_500,
  // The one funded invoice below; the request's own totals are what was planned.
  cameInCents: 187_050,
  status: "partly_funded",
  fundedAt: "2026-11-02T15:20:04.000Z",
  proposalId: id(533),
  advanceBps: 9_000,
  feeBps: 300,
  ...over,
});

export const FACTORING_REQUESTS: RequestSummary[] = [
  factoringRequest({}),
  factoringRequest({ id: id(534), createdAt: "2026-10-30T14:00:00.000Z", invoiceCount: 1, status: "unknown", fundedAt: null, cameInCents: 0 }),
  factoringRequest({ id: id(535), createdAt: "2026-10-23T14:00:00.000Z", invoiceCount: 2, status: "funded", cameInCents: 561_150 }),
  factoringRequest({ id: id(536), createdAt: "2026-10-16T14:00:00.000Z", invoiceCount: 1, status: "declined", fundedAt: null, cameInCents: 0 }),
];

export const FACTORING_REQUEST: RequestDetail = {
  ...factoringRequest({}),
  lines: [
    {
      id: id(537),
      invoiceId: INVOICE_ID,
      invoiceNumber: "BR-INV-10231",
      customerId: CUSTOMER_ID,
      customerName: "Tanglewood Grocery Supply",
      attempt: 1,
      balanceCents: 215_000,
      advanceCents: 193_500,
      feeCents: 6_450,
      netCents: 187_050,
      reserveCents: 21_500,
      status: "funded",
      providerRef: "fsim_adv_3f2a9c1d7e5b4a0c9d8e7f6a",
      moneyActionId: id(538),
      settledAt: "2026-11-02T15:20:04.000Z",
      packet: {
        invoice: true,
        rateConfirmation: { onFile: true, documentId: FACTORING_DOC_RC },
        billOfLading: { onFile: true, documentId: FACTORING_DOC_BOL },
        pod: { onFile: true, portalRunId: RUN_ID },
      },
    },
    {
      id: id(539),
      invoiceId: id(540),
      invoiceNumber: "BR-INV-10236",
      customerId: CUSTOMER_ID,
      customerName: "Tanglewood Grocery Supply",
      attempt: 1,
      balanceCents: 214_998,
      advanceCents: 193_498,
      feeCents: 6_450,
      netCents: 187_048,
      reserveCents: 21_500,
      status: "unknown",
      providerRef: null,
      moneyActionId: id(541),
      settledAt: null,
      packet: {
        invoice: true,
        rateConfirmation: { onFile: true, documentId: FACTORING_DOC_RC },
        billOfLading: { onFile: false, documentId: null },
        pod: { onFile: false, portalRunId: null },
      },
    },
    {
      id: id(542),
      invoiceId: id(543),
      invoiceNumber: "BR-INV-10238",
      customerId: CUSTOMER_ID,
      customerName: "Tanglewood Grocery Supply",
      attempt: 1,
      balanceCents: 215_002,
      advanceCents: 193_502,
      feeCents: 6_450,
      netCents: 187_052,
      reserveCents: 21_500,
      status: "declined",
      providerRef: null,
      moneyActionId: id(544),
      settledAt: "2026-11-02T15:20:03.000Z",
      packet: {
        invoice: true,
        rateConfirmation: { onFile: false, documentId: null },
        billOfLading: { onFile: false, documentId: null },
        pod: { onFile: false, portalRunId: null },
      },
    },
  ],
};

export const FACTORED_LINE = { requestId: FACTORING_REQUEST_ID, status: "funded", at: "2026-11-02T15:20:04.000Z" };

// The Fuel and tax rates page: a pinned diesel price with a newer lookup waiting, one state pinned
// by hand, one state whose lookup could not match its number, and one not pinned yet. Synthetic
// pages only (rates.example).
const RATE_BASE: RateView = {
  id: "5a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  kind: "diesel_index",
  state: null,
  status: "pinned",
  valueMcents: 365_700,
  perGallon: "$3.657",
  sourceUrl: "https://rates.example/diesel/weekly",
  sourceTitle: "Weekly diesel prices, all regions",
  sourceHost: "rates.example",
  quote: null,
  asOf: null,
  effectiveFrom: "2026-10-19",
  pinnedAt: "2026-10-20T14:00:00.000Z",
  pinnedOn: "2026-10-20",
  byYou: true,
  typed: false,
  createdAt: "2026-10-20T13:58:00.000Z",
};
export const RATE_PINNED: RateView = RATE_BASE;
export const RATE_SUGGESTED: RateView = {
  ...RATE_BASE,
  id: "6b2e3d4c-5f6a-4b7c-9d8e-0f1a2b3c4d5e",
  status: "suggested",
  valueMcents: 371_200,
  perGallon: "$3.712",
  quote: "U.S. on-highway diesel averaged 3.712 dollars a gallon for the week of October 26, 2026.",
  asOf: "2026-10-26",
  effectiveFrom: null,
  pinnedAt: null,
  pinnedOn: null,
  createdAt: "2026-10-27T15:00:00.000Z",
};
export const RATE_UNCONFIRMED: RateView = {
  ...RATE_BASE,
  id: "7c3f4e5d-6a7b-4c8d-8e9f-1a2b3c4d5e6f",
  kind: "ifta_rate",
  state: "IL",
  status: "unconfirmed",
  valueMcents: null,
  perGallon: null,
  sourceUrl: "https://rates.example/fuel-tax/illinois",
  sourceTitle: "Illinois motor fuel tax",
  quote: null,
  asOf: null,
  effectiveFrom: null,
  pinnedAt: null,
  pinnedOn: null,
  byYou: false,
  createdAt: "2026-10-27T15:05:00.000Z",
};
export const RATES_PAGE: RatesPage = {
  today: "2026-10-27",
  canPin: true,
  lookupsLeft: 17,
  diesel: { pinned: RATE_PINNED, suggestion: RATE_SUGGESTED },
  states: [
    { code: "IL", name: "Illinois", pinned: null, suggestion: RATE_UNCONFIRMED },
    {
      code: "IN",
      name: "Indiana",
      pinned: {
        ...RATE_BASE,
        id: "8d4a5f6e-7b8c-4d9e-9f0a-2b3c4d5e6f7a",
        kind: "ifta_rate",
        state: "IN",
        valueMcents: 61_000,
        perGallon: "$0.6100",
        sourceUrl: "https://rates.example/fuel-tax/indiana",
        sourceTitle: "Indiana fuel tax rates",
        byYou: false,
        typed: true,
      },
      suggestion: null,
    },
    { code: "OH", name: "Ohio", pinned: null, suggestion: null },
  ],
};
export const RATES_EMPTY: RatesPage = {
  ...RATES_PAGE,
  diesel: { pinned: null, suggestion: null },
  states: RATES_PAGE.states.map((s) => ({ ...s, pinned: null, suggestion: null })),
};

// ---- Drivers list (/drivers) ----

const insightDriver = (over: Partial<DriverRecord> & Pick<DriverRecord, "id" | "code" | "firstName" | "lastName">): DriverRecord => ({
  email: `${over.code.toLowerCase()}@example.test`,
  workerType: "owner_operator",
  payBasis: "percent",
  perMileCents: null,
  percentBps: 7_500,
  flatPerLoadCents: null,
  advanceLimitCents: null,
  escrowBalanceCents: 0 as Cents,
  ownInsurance: false,
  truckUnit: null,
  tankGallons: 200,
  activeFrom: "2026-01-05",
  activeTo: null,
  moneyArmed: true,
  ...over,
});

// The driver insights' records for the 28 days ending 2026-11-02: two active drivers with pay,
// loads and an advance owed, and one who left in September with a deficit still open.
export const DRIVER_INSIGHT_INPUT: DriverInsightsInput = {
  drivers: [
    insightDriver({ id: DRIVER_ID, code: "BR-D07", firstName: "Rosa", lastName: "Delgado" }),
    insightDriver({ id: id(21), code: "BR-D12", firstName: "Marcus", lastName: "Hale", workerType: "company", payBasis: "per_mile", perMileCents: 62 as Cents, percentBps: null, moneyArmed: false }),
    insightDriver({ id: id(22), code: "BR-D15", firstName: "Lena", lastName: "Ortiz", activeTo: "2026-09-30" }),
  ],
  periods: [{ id: PERIOD_ID, periodStart: "2026-10-19", periodEnd: "2026-10-25", status: "paid" }],
  settlements: [
    { id: id(23), periodId: PERIOD_ID, driverId: DRIVER_ID, status: "paid", grossCents: 284_000 as Cents, deductionsCents: 61_500 as Cents, netCents: 222_500 as Cents, carryForwardCents: 0 as Cents, exceptionCount: 0, paidAt: "2026-10-31T14:00:00Z" },
    { id: id(24), periodId: PERIOD_ID, driverId: id(21), status: "paid", grossCents: 198_400 as Cents, deductionsCents: 12_000 as Cents, netCents: 186_400 as Cents, carryForwardCents: 0 as Cents, exceptionCount: 0, paidAt: "2026-10-31T14:00:00Z" },
  ],
  lines: [{ settlementId: id(23), kind: "fuel", amountCents: -41_250 as Cents }],
  loads: [
    { driverId: DRIVER_ID, deliveredOn: "2026-10-21", loadedMiles: 612, emptyMiles: 48 },
    { driverId: id(21), deliveredOn: "2026-10-22", loadedMiles: 455, emptyMiles: 30 },
    { driverId: id(21), deliveredOn: "2026-10-24", loadedMiles: 380, emptyMiles: 22 },
  ],
  advances: [
    {
      id: id(25),
      driverId: DRIVER_ID,
      requestRef: "req-fx-25",
      requestedAt: "2026-10-28T15:00:00Z",
      requestedOn: "2026-10-28",
      amountCents: 25_000 as Cents,
      feeCents: 0 as Cents,
      status: "paid",
      recoveredCents: 0 as Cents,
      source: "seed",
      reasonCategory: null,
      paidAt: "2026-10-28T16:00:00Z",
      loadId: null,
      takenBackCents: 0 as Cents,
    },
  ],
  deficits: [{ driverId: id(22), owedCents: 8_000 as Cents }],
};
// The drivers with an active card: Rosa only, so Marcus shows "No card".
export const CARDED_DRIVER_IDS: string[] = [DRIVER_ID];
