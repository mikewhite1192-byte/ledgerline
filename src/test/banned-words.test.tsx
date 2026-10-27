// @vitest-environment jsdom
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reportTable, type ReportLoad } from "@/components/agent/report-table";
import { toMessages } from "@/components/agent/turn-view";
import { ChatThread } from "@/components/app/chat-thread";
import { DataTable } from "@/components/app/data-table";
import { Paystub } from "@/components/app/paystub";
import { ProposalCard, type ProposalAudit, type ProposalStatus } from "@/components/app/proposal-card";
import { EmptyState, ERROR_CATEGORIES, ErrorState, FeatureOff, LoadingState, PageNotFound } from "@/components/app/states";
import { BADGE_STATUSES, StatusBadge } from "@/components/app/status-badge";
import { ToastProvider } from "@/components/app/toast";
import { ApproveAll } from "@/components/settlements/approve-all";
import { ContinueBatch } from "@/components/settlements/continue-batch";
import { doneNote } from "@/components/settlements/action-button";
import { FuelChecks } from "@/components/fuel/fuel-checks";
import { HowWorkedOut } from "@/components/trace/how-worked-out";
import { ADVANCE_PROPOSAL, MOVE_PROPOSAL, PAYMENT_PROPOSAL, PAYSTUB, SHORT_WEEK_PAYSTUB } from "@/app/design/sample-data";
import { flags } from "@/config/flags";
import { TOOL_REGISTRY } from "@/lib/agent/gateway/registry";
import type { TurnView } from "@/lib/agent/view";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";
import type { InvoiceReviewView } from "@/lib/invoices/review-read";
import { TERMS } from "@/lib/format/terms";
import {
  compareLine,
  DISMISS_WORDS,
  FUEL_LABELS,
  FUEL_PAGE_WORDS,
  FUEL_STATUS_WORDS,
  fuelHelp,
  noSuggestionLine,
  runLine,
} from "@/lib/fuel/help";
import { SUBJECT_STATUSES } from "@/lib/money/types";
import { INVOICE_REVIEW_STATUSES } from "@/lib/rules-engine";
import { FUEL_CHECK_NAMES, NO_SUGGESTION_REASONS } from "@/lib/rules-engine/fuel";
import { REPORT_COLUMNS, REPORT_NAMES, REPORT_TITLES, type ReportName, type ReportResult, type ReportRow } from "@/lib/reports/types";
import { DEMO_ANCHOR } from "@/lib/seed/anchor";
import { DEMO_CARRIERS } from "@/lib/seed/carriers";
import { buildCarrierPlan } from "@/lib/seed/plan";
import { EXCEPTION_LABELS, LEG_LABELS, PARK_LABELS, SETTLEMENT_OUTCOMES } from "@/lib/settlements/labels";
import type { SettlementRecordView } from "@/lib/settlements/views";
import { SAMPLE_PROPOSAL_ID, SAMPLE_TURN_ID, sampleTrace } from "@/lib/trace/sample";
import { VOICE_STATUS_WORDS } from "@/lib/voice/words";
import * as fx from "./page-fixtures";

// Every screen a person reads, rendered with fixture rows and scanned for the words that belong to
// the code, not to a trucking office (design-ui-ease section 3). A new route file under src/app (a
// page, a layout, a loading or not-found screen) must be rendered here or listed below with the
// reason; nothing is skipped quietly.

// The banned words. Each is matched as a whole word (plurals included), in the visible text and in
// the labels a screen reader or a hover reads.
const BANNED: readonly { word: string; re: RegExp }[] = [
  // A "proposal" is our word for a card or request waiting for approval.
  { word: "proposal", re: /\bproposals?\b/i },
  // A carrier is never a "tenant" on screen; that is the database's word.
  { word: "tenant", re: /\btenants?\b/i },
  // "Ledger" is the money table; a person reads "payment record".
  { word: "ledger", re: /\bledgers?\b/i },
  // The executor is the code that pays; a person reads "paid", "sent" or "posted".
  { word: "executor", re: /\bexecutors?\b/i },
  // Idempotency keys are plumbing; never shown.
  { word: "idempotency", re: /\bidempoten/i },
  // A request body is never shown, nor named.
  { word: "payload", re: /\bpayloads?\b/i },
  // The second check "passed" or "did not pass"; it never gives a "verdict".
  { word: "verdict", re: /\bverdicts?\b/i },
  // The auditor model is "the second check" on screen.
  { word: "auditor", re: /\bauditors?\b/i },
  // The gateway is the agent's safety check.
  { word: "gateway", re: /\bgateways?\b/i },
  // The rules engine is "your pay rules" or "your rate rules".
  { word: "rules engine", re: /\brules engines?\b/i },
  // The engine's total is the "Invoice total".
  { word: "engine total", re: /\bengine totals?\b/i },
  // A read-back is "confirmed by QuickBooks" or "confirmed by the card".
  { word: "read-back", re: /\bread-backs?\b/i },
  // An upstream id or error is a "Reference" under Details, or a plain category.
  { word: "upstream", re: /\bupstream\b/i },
  // The job cap is the "hourly budget".
  { word: "job cap", re: /\bjob caps?\b/i },
  // Same budget, older wording.
  { word: "hourly allowance", re: /\bhourly allowances?\b/i },
  // Unapplied credit is "Credit on account".
  { word: "unapplied", re: /\bunapplied\b/i },
  // Aging is "how late"; the report is "Open balances by how late they are".
  { word: "aging", re: /\baging\b/i },
  // Accessorials are "Extra charges" (the word itself lives only in the Term help, see below).
  { word: "accessorial", re: /\baccessorials?\b/i },
  // A zone is "Eastern time", never America/New_York.
  { word: "America/", re: /\bAmerica\//i },
  // A stored date is written in words ("Oct 19, 2026"), never 2026-10-19, nor a stored timestamp
  // (2026-10-19T15:00:00.000Z, where the T after the day leaves no word boundary to end on).
  { word: "ISO date", re: /\b\d{4}-\d{2}-\d{2}(?!\d)/ },
  // A record is named by its reference, never by the tail of its database id.
  { word: "id tail", re: /\bending [0-9a-f]{6}\b/i },
  // Money is in dollars: "$0.00 of $2.00", never "0 cents of".
  { word: "cents of", re: /\bcents of\b/i },
];

// The one word the hover help may say: the extra charges help names the trade word so a person who
// knows "accessorials" finds it. Only inside a Term's own help text, which is exactly a TERMS value.
const TERM_HELP = new Set<string>(Object.values(TERMS));
const TERM_HELP_ALLOWS = new Set(["accessorial"]);

// The broker's portal is a stand-in for an outside website the runner reads; its date stamps are
// that site's own format (the runner's evidence parses them), so only the date rule is lifted there.
const PORTAL_ALLOWS = new Set(["ISO date"]);

// Labels a person reads without seeing them as text: a screen reader, a hover, an empty input.
const ATTRIBUTES = ["aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "title", "alt", "placeholder"];

type Hit = { word: string; text: string };

function hitsIn(text: string, allow: ReadonlySet<string>): Hit[] {
  const out: Hit[] = [];
  for (const b of BANNED) {
    if (allow.has(b.word)) continue;
    const m = b.re.exec(text);
    if (m) {
      const at = Math.max(0, m.index - 40);
      out.push({ word: b.word, text: text.slice(at, m.index + m[0].length + 40).replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}

function textOf(root: Node): string {
  const parts: string[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) parts.push(n.nodeValue ?? "");
  // Each text node on its own (so two cells never run together into a false date or word), and the
  // run of them (so a phrase React split across nodes is still read whole).
  return `${parts.join("\n")}\n${root.textContent ?? ""}`;
}

export function scan(root: HTMLElement, allow: ReadonlySet<string> = new Set()): Hit[] {
  const copy = root.cloneNode(true) as HTMLElement;
  const hits: Hit[] = [];
  for (const tip of Array.from(copy.querySelectorAll('[role="tooltip"]'))) {
    const text = tip.textContent ?? "";
    if (!TERM_HELP.has(text)) continue;
    hits.push(...hitsIn(text, new Set([...allow, ...TERM_HELP_ALLOWS])));
    tip.remove();
  }
  hits.push(...hitsIn(textOf(copy), allow));
  for (const el of Array.from(copy.querySelectorAll("*"))) {
    for (const name of ATTRIBUTES) {
      const v = el.getAttribute(name);
      if (v) hits.push(...hitsIn(v, allow).map((h) => ({ ...h, text: `[${name}] ${h.text}` })));
    }
    if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type) && el.value) {
      hits.push(...hitsIn(el.value, allow));
    }
  }
  return hits;
}

// ---- The pages' reads, answered from fixtures ----

const SESSION: Session = { sub: "sub-test-1", email: fx.EMAIL, tenantId: "00000000-0000-4000-8000-000000000001" };
const state = vi.hoisted(() => ({ fx: {} as Record<string, unknown>, session: null as Session | null }));
const get = <T,>(key: string) => state.fx[key] as T;

const fakeQ = {
  async query(sql: string) {
    if (/FROM tenants/.test(sql)) return [{ name: fx.TENANT.name, timezone: fx.TENANT.timezone }];
    if (/FROM memberships/.test(sql)) return [{ ok: 1, id: "membership-1", email: fx.EMAIL, role: "admin" }];
    if (/count\(\*\) FROM drivers/.test(sql)) return [{ drivers: 25, loads: 310, periods: 4 }];
    if (/SELECT id, load_number, dest_city, dest_state FROM loads/.test(sql)) return fx.CLIP_LOADS;
    throw new Error(`unexpected read: ${sql.slice(0, 80)}`);
  },
} as unknown as Queryable;

vi.mock("@/lib/tenant/context", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant/context")>();
  return {
    ...real,
    withRequestTenant: async <T,>(fn: (q: Queryable, s: Session) => Promise<T>) => fn(fakeQ, SESSION),
    withSessionTenant: async <T,>(_s: Session, fn: (q: Queryable) => Promise<T>) => fn(fakeQ),
  };
});
vi.mock("@/lib/auth/session", () => ({ getSession: async () => state.session, requireSession: async () => SESSION }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "portal-session" }) }) }));
// The typeface is built by the framework's compiler, which a test does not run; only its class name is read.
vi.mock("@/app/fonts", () => ({ sans: { variable: "font-sans" } }));
vi.mock("next/navigation", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/navigation")>();
  return {
    ...real,
    notFound: () => {
      throw new Error("notFound");
    },
    redirect: (to: string) => {
      throw new Error(`redirect ${to}`);
    },
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
    usePathname: () => "/",
    useSearchParams: () => new URLSearchParams(),
  };
});
vi.mock("@/app/sign-in/actions", () => ({ signInAction: async () => {} }));
vi.mock("@/app/ai-proof-action", () => ({ proofCallAction: async () => ({ kind: "idle" }) }));
vi.mock("@/app/settings/demo/reset-action", () => ({ resetDemoAction: async () => {} }));
vi.mock("@/app/models/clear-alert-action", () => ({ clearAlertAction: async () => {} }));
vi.mock("@/lib/advances/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/advances/read")>()),
  readDriverOptions: async () => get("drivers"),
  readAdvanceList: async () => get("advances"),
  readAdvanceRecord: async () => get("advanceRecord"),
  readDriverAdvances: async () => get("driverAdvances"),
}));
vi.mock("@/lib/advances/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/advances/identity")>()),
  readDriverIdentity: async () => get("identity"),
}));
vi.mock("@/lib/clips/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clips/service")>()),
  listClips: async () => ({ ok: true, clips: get("clips") }),
}));
vi.mock("@/lib/invoices/views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invoices/views")>()),
  readPaymentForm: async () => get("paymentForm"),
  readInvoiceList: async () => get("invoices"),
  readQueueView: async () => get("queue"),
  readInvoiceRecord: async () => get("invoiceRecord"),
  readPaymentRecord: async () => get("paymentRecord"),
  readCustomerRecord: async () => get("customerRecord"),
  readLoadRecord: async () => get("loadRecord"),
}));
vi.mock("@/lib/documents/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/service")>()),
  getDocument: async () => get("document"),
  listDocuments: async () => get("documents"),
}));
vi.mock("@/lib/driver-notes/view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/driver-notes/view")>()),
  listNotePeriods: async () => get("periods"),
  readPeriodNotes: async () => get("periodNotes"),
  readDriverView: async () => get("driverView"),
}));
vi.mock("@/lib/recon/view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recon/view")>()),
  readCardHome: async () => get("cardHome"),
  readCardBreak: async () => get("cardBreak"),
}));
vi.mock("@/lib/agent/gateway/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/gateway/store")>()),
  readEngineProposalViews: async () => get("invoiceProposals"),
  readAgentModelWeek: async () => get("week"),
  readRecentAgentTurns: async () => get("turns"),
}));
vi.mock("@/lib/ai/spend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/spend")>()),
  readSpend: async () => get("spend"),
  readRecentCalls: async () => get("calls"),
}));
vi.mock("@/lib/ai/watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/watch")>()),
  readDaySpend: async () => get("day"),
  readSpendAlerts: async () => get("alerts"),
}));
vi.mock("@/lib/sweep/view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sweep/view")>()),
  readSweepHome: async () => get("sweepHome"),
  readSweepPage: async () => get("sweepPage"),
}));
vi.mock("@/lib/fuel/view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fuel/view")>()),
  readFuelPage: async () => get("fuelPage"),
}));
vi.mock("@/lib/portal/views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/views")>()),
  runView: async () => get("runView"),
  listRuns: async () => get("runs"),
  portalLoadChoices: async () => get("runChoices"),
}));
vi.mock("@/lib/portal/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/read")>()),
  findPortalLoads: async () => get("portalLines"),
  portalLoadByReference: async () => get("portalDetail"),
}));
vi.mock("@/lib/portal/tenant", () => ({
  withPortalTenant: async <T,>(_c: string | undefined, _now: Date, fn: (q: Queryable, ids: { tenantId: string; sessionId: string }) => Promise<T>) =>
    fn(fakeQ, { tenantId: SESSION.tenantId, sessionId: "portal-session" }),
}));
vi.mock("@/lib/adapters/accounting/qbo/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters/accounting/qbo/store")>()),
  connectionSummary: async () => get("qbo"),
  membershipOf: async () => ({ id: "membership-1", role: "admin" }),
}));
vi.mock("@/lib/seed/reset", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seed/reset")>()),
  demoCarrierOf: async () => DEMO_CARRIERS[0],
  previewDemoReset: async () => get("demoPreview"),
}));
vi.mock("@/lib/settlements/views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settlements/views")>()),
  readSettlementsView: async () => get("settlementsView"),
  readSettlementRecord: async () => get("settlementRecord"),
  readDriverRecord: async () => get("driverRecord"),
  readBatchRecord: async () => get("batchRecord"),
}));
vi.mock("@/lib/settlements/list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settlements/list")>()),
  readPaystubAsk: async () => get("paystubAsk"),
}));
vi.mock("@/lib/invoices/review-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invoices/review-read")>()),
  readReviewQueue: async () => get("reviewQueue"),
  readInvoiceReview: async () => get("invoiceReview"),
  readMemberRoles: async () => new Map([[fx.MEMBER_ID, "staff"]]),
}));
vi.mock("@/lib/voice/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice/read")>()),
  readVoiceList: async () => get("voiceList"),
  readVoiceDetail: async () => get("voiceDetail"),
}));

function defaults(): Record<string, unknown> {
  return {
    drivers: fx.DRIVERS,
    advances: fx.ADVANCES,
    advanceRecord: fx.ADVANCE_RECORD,
    driverAdvances: fx.DRIVER_ADVANCES,
    identity: fx.IDENTITY,
    clips: fx.CLIPS,
    paymentForm: fx.PAYMENT_FORM,
    invoices: fx.INVOICES,
    queue: fx.QUEUE,
    invoiceRecord: fx.INVOICE_RECORD,
    paymentRecord: fx.PAYMENT_RECORD,
    customerRecord: fx.CUSTOMER_RECORD,
    loadRecord: fx.LOAD_RECORD,
    document: fx.DOCUMENTS[0],
    documents: fx.DOCUMENTS,
    periods: fx.PERIODS,
    periodNotes: fx.PERIOD_NOTES,
    driverView: fx.DRIVER_VIEW,
    invoiceProposals: fx.INVOICE_PROPOSALS,
    week: fx.WEEK,
    turns: fx.TURNS,
    spend: fx.SPEND,
    calls: fx.CALLS,
    day: fx.DAY,
    alerts: fx.ALERTS,
    sweepHome: fx.SWEEP_HOME,
    sweepPage: fx.SWEEP_PAGE,
    fuelPage: fx.FUEL_PAGE,
    runView: fx.RUN_VIEW,
    runs: fx.RUNS,
    runChoices: fx.RUN_CHOICES,
    portalLines: fx.PORTAL_LINES,
    portalDetail: fx.PORTAL_DETAIL,
    qbo: fx.QBO,
    demoPreview: fx.DEMO_PREVIEW,
    voiceList: fx.VOICE_LIST,
    voiceDetail: fx.VOICE_DETAIL,
    settlementsView: fx.SETTLEMENTS_VIEW,
    settlementRecord: fx.SETTLEMENT_RECORD,
    driverRecord: fx.DRIVER_RECORD,
    batchRecord: fx.BATCH_RECORD,
    paystubAsk: null,
    reviewQueue: fx.REVIEW_QUEUE,
    invoiceReview: fx.INVOICE_REVIEW,
    cardHome: fx.CARD_HOME,
    cardBreak: fx.CARD_BREAKS[0],
  };
}

// Every switch on, so each page shows its working state, not the off page.
const SWITCHES = Object.keys(flags).filter((k) => typeof (flags as Record<string, unknown>)[k] === "boolean");
const saved = Object.fromEntries(SWITCHES.map((k) => [k, (flags as Record<string, unknown>)[k]]));
beforeAll(() => {
  for (const k of SWITCHES) (flags as Record<string, unknown>)[k] = true;
  vi.stubGlobal("fetch", () => new Promise(() => {}));
});
afterAll(() => {
  for (const k of SWITCHES) (flags as Record<string, unknown>)[k] = saved[k];
  vi.unstubAllGlobals();
});
beforeEach(() => {
  state.fx = defaults();
  state.session = null;
});
afterEach(() => cleanup());

// A server page may return an async server component at its top; run it to its tree.
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (isValidElement(node) && typeof node.type === "function") {
    let out: unknown;
    try {
      out = (node.type as (p: unknown) => unknown)(node.props);
    } catch {
      return node;
    }
    if (out instanceof Promise) return resolve((await out) as ReactNode);
  }
  return node;
}

async function renderPage(page: () => Promise<ReactNode>): Promise<HTMLElement> {
  const tree = await resolve(await page());
  let container!: HTMLElement;
  await act(async () => {
    container = render(<ToastProvider>{tree}</ToastProvider>).container;
  });
  return container;
}

const p = <T extends object>(v: T) => Promise.resolve(v);
const sp = (v: Record<string, string> = {}) => ({ searchParams: p(v) });
const ID = fx.ID;

// shows: words the variant must render, so it is known to have taken the path it names.
type Variant = { name: string; setup?: () => void; load: () => Promise<ReactNode>; shows?: string };
// failureScreen: the route file is itself a failure screen (not found), so it must show its title.
type PageCase = { file: string; variants: Variant[]; allow?: ReadonlySet<string>; failureScreen?: boolean };

// A loading screen: what a person sees while the page's reads run.
const loading = (file: string, load: () => Promise<{ default: () => ReactNode }>): PageCase => ({
  file,
  variants: [{ name: "loading", load: async () => (await load()).default() }],
});

// The invoice record page with its Review card in each state worth reading.
const REVIEW_CASES: [string, InvoiceReviewView][] = [
  ["rate mismatch, not reviewed", fx.INVOICE_REVIEW],
  ["post failed", fx.reviewView("sync_error", ["posting_failed"])],
  ["post not confirmed", fx.reviewView("sync_error", ["posting_unknown", "posted_amount_differs"])],
  [
    "duplicate warning",
    fx.reviewView("duplicate_warning", ["same_amount_recent", "not_reviewed"], { duplicates: [{ id: fx.ID, invoiceNumber: "BR-INV-10240" }] }),
  ],
  ["ready, not posted", fx.reviewView("ready_to_send", ["not_posted"], { reviewedAt: "2026-10-28T15:00:00.000Z", reviewedByMembershipId: fx.MEMBER_ID, reviewNote: "Checked the rate confirmation." })],
  [
    "ready, posted, unsent",
    fx.reviewView("ready_to_send", [], { reviewedAt: "2026-10-28T15:00:00.000Z", reviewedByMembershipId: fx.MEMBER_ID, posted: true, emailStatus: "need_to_send" }),
  ],
  [
    "sent",
    fx.reviewView("ready_to_send", [], {
      inQueue: false,
      reviewedAt: "2026-10-28T15:00:00.000Z",
      reviewedByMembershipId: fx.MEMBER_ID,
      posted: true,
      emailStatus: "email_sent",
      sentOn: "2026-10-29",
      sentByMembershipId: fx.MEMBER_ID,
    }),
  ],
];

// A paystub's record page in each state: a payout not confirmed yet, a draft with its card, a
// parked draft, a $0 week that carries forward, and a paid one still to post.
const draftOf = (over: Partial<SettlementRecordView["settlement"]>): SettlementRecordView => ({
  ...fx.SETTLEMENT_RECORD,
  settlement: { ...fx.SETTLEMENT_RECORD.settlement, status: "draft", ...over },
  proposal: { ...fx.SETTLEMENT_RECORD.proposal!, status: "proposed", note: null },
  legs: [],
  latest: { settlement_payout: null, settlement_bill: null, settlement_bill_payment: null },
});
const SETTLEMENT_CASES: [string, SettlementRecordView][] = [
  ["approved, payout not confirmed", fx.SETTLEMENT_RECORD],
  [
    "approved, payout failed",
    {
      ...fx.SETTLEMENT_RECORD,
      proposal: { ...fx.SETTLEMENT_RECORD.proposal!, note: "failed" },
      latest: { settlement_payout: "failed", settlement_bill: null, settlement_bill_payment: null },
    },
  ],
  ["draft with its card", draftOf({})],
  [
    "parked",
    { ...draftOf({ parkedReason: "line_amount_changed", parkedAt: "2026-10-27T15:00:00.000Z" }), parkedLabel: "A pay line changed since the draft" },
  ],
  ["net zero, carried forward", draftOf({ netCents: 0, carryForwardCents: 5_000 })],
  [
    "paid, still to post",
    {
      ...fx.SETTLEMENT_RECORD,
      settlement: { ...fx.SETTLEMENT_RECORD.settlement, status: "paid", paidAt: "2026-10-27T16:00:00.000Z" },
      legs: [...fx.SETTLEMENT_RECORD.legs, { ...fx.SETTLEMENT_RECORD.legs[0], id: fx.ID, state: "confirmed", attempt: 3, failureCategory: null }],
      latest: { settlement_payout: "confirmed", settlement_bill: "failed", settlement_bill_payment: null },
    },
  ],
];

// The card check's switch sits inside its own settings block, so its pages turn it on themselves.
const cardReconSaved = flags.cardRecon.enabled;
afterAll(() => {
  flags.cardRecon.enabled = cardReconSaved;
});
const cardsOn = (fixtures: Record<string, unknown>) => () => {
  flags.cardRecon.enabled = true;
  Object.assign(state.fx, fixtures);
};
const NO_RUN_HOME = { run: null, breaks: [], open: { needsYou: 0, notConfirmed: 0 } };
const CARD_PAGE_CASES: [string, Record<string, unknown>][] = [
  ["differences", { cardHome: fx.CARD_HOME }],
  ["first visit", { cardHome: NO_RUN_HOME }],
  ["running", { cardHome: { ...NO_RUN_HOME, run: { ...fx.CARD_RUN, status: "running", phase: "records", finishedAt: null, unchecked: [] } } }],
  ["stopped", { cardHome: { ...NO_RUN_HOME, run: { ...fx.CARD_RUN, status: "failed", failCategory: "unknown" } } }],
  ["all clear", { cardHome: { ...NO_RUN_HOME, run: { ...fx.CARD_RUN, counts: { ...fx.CARD_RUN.counts, needsYou: 0, notConfirmed: 0 }, unchecked: [] } } }],
];
const CARD_BREAK_CASES: [string, Record<string, unknown>][] = [
  ...fx.CARD_BREAKS.map((b, i): [string, Record<string, unknown>] => [
    `${b.category} ${i + 1}`,
    { cardBreak: b, invoiceProposals: b.fixKind === "card_match" && b.proposalId ? [fx.CARD_MATCH_PROPOSAL] : [] },
  ]),
  ["fixed", { cardBreak: { ...fx.CARD_BREAKS[2], status: "resolved" }, invoiceProposals: [] }],
  ["dismissed", { cardBreak: { ...fx.CARD_BREAKS[3], status: "dismissed", dismissCategory: "wrong_system" }, invoiceProposals: [] }],
];

// Every page that renders, keyed by its file under src/app, with each state worth reading.
const PAGES: PageCase[] = [
  {
    file: "cards/page.tsx",
    variants: CARD_PAGE_CASES.map(([name, fixtures]) => ({
      name,
      setup: cardsOn(fixtures),
      load: async () => (await import("@/app/cards/page")).default(),
    })),
  },
  {
    file: "cards/[breakId]/page.tsx",
    variants: CARD_BREAK_CASES.map(([name, fixtures]) => ({
      name,
      setup: cardsOn(fixtures),
      load: async () => (await import("@/app/cards/[breakId]/page")).default({ params: p({ breakId: ID }) }),
      shows: "Our records",
    })),
  },
  {
    file: "page.tsx",
    variants: [
      { name: "home", load: async () => (await import("@/app/page")).default(sp()) },
      {
        name: "asked about a paystub",
        setup: () => (state.fx.paystubAsk = fx.PAYSTUB_ASK),
        load: async () => (await import("@/app/page")).default(sp({ paystub: ID })),
      },
    ],
  },
  {
    file: "advances/page.tsx",
    variants: [
      { name: "all", load: async () => (await import("@/app/advances/page")).default(sp()) },
      { name: "paid", load: async () => (await import("@/app/advances/page")).default(sp({ status: "paid" })) },
      { name: "not armed", load: async () => (await import("@/app/advances/page")).default(sp({ armed: "no" })) },
      { name: "empty", setup: () => (state.fx.advances = []), load: async () => (await import("@/app/advances/page")).default(sp()) },
    ],
  },
  {
    file: "advances/new/page.tsx",
    variants: [{ name: "form", load: async () => (await import("@/app/advances/new/page")).default() }],
  },
  {
    file: "clips/page.tsx",
    variants: [
      { name: "clips", load: async () => (await import("@/app/clips/page")).default() },
      { name: "empty", setup: () => (state.fx.clips = []), load: async () => (await import("@/app/clips/page")).default() },
    ],
  },
  {
    file: "customer-payments/new/page.tsx",
    variants: [
      { name: "form", load: async () => (await import("@/app/customer-payments/new/page")).default(sp()) },
      {
        name: "one customer",
        load: async () => (await import("@/app/customer-payments/new/page")).default(sp({ customer: fx.PAYMENT_FORM[0].id })),
      },
    ],
  },
  {
    file: "documents/page.tsx",
    variants: [
      { name: "list", load: async () => (await import("@/app/documents/page")).default() },
      { name: "empty", setup: () => (state.fx.documents = []), load: async () => (await import("@/app/documents/page")).default() },
    ],
  },
  {
    file: "documents/[id]/page.tsx",
    variants: fx.DOCUMENTS.map((d) => ({
      name: d.readStatus,
      setup: () => (state.fx.document = d),
      load: async () => (await import("@/app/documents/[id]/page")).default({ params: p({ id: d.id }) }),
    })),
  },
  {
    file: "driver-notes/page.tsx",
    variants: [
      { name: "periods", load: async () => (await import("@/app/driver-notes/page")).default() },
      { name: "empty", setup: () => (state.fx.periods = []), load: async () => (await import("@/app/driver-notes/page")).default() },
    ],
  },
  {
    file: "driver-notes/[settlementId]/view/page.tsx",
    variants: [
      {
        name: "driver view",
        load: async () =>
          (await import("@/app/driver-notes/[settlementId]/view/page")).default({
            params: p({ settlementId: fx.DRIVER_VIEW.source.settlement.id }),
          }),
      },
    ],
  },
  {
    file: "pay/[periodId]/notes/page.tsx",
    variants: [
      {
        name: "notes",
        load: async () => (await import("@/app/pay/[periodId]/notes/page")).default({ params: p({ periodId: fx.PERIODS[0].id }) }),
      },
    ],
  },
  {
    file: "invoices/page.tsx",
    variants: [
      { name: "first tab", load: async () => (await import("@/app/invoices/page")).default(sp()) },
      ...["review", "to-invoice", "exceptions", "invoices"].map((tab) => ({
        name: tab,
        load: async () => (await import("@/app/invoices/page")).default(sp({ tab })),
      })),
      ...INVOICE_REVIEW_STATUSES.map((status) => ({
        name: `review, ${status}`,
        setup: () => (state.fx.reviewQueue = { ...fx.REVIEW_QUEUE, rows: fx.REVIEW_QUEUE.rows.filter((r) => r.status === status) }),
        load: async () => (await import("@/app/invoices/page")).default(sp({ tab: "review", status })),
      })),
      {
        name: "review, a status with none",
        setup: () => (state.fx.reviewQueue = { ...fx.REVIEW_QUEUE, rows: [] }),
        load: async () => (await import("@/app/invoices/page")).default(sp({ tab: "review", status: "sync_error" })),
      },
      {
        name: "review, nothing to review",
        setup: () => (state.fx.reviewQueue = { counts: Object.fromEntries(INVOICE_REVIEW_STATUSES.map((st) => [st, 0])), rows: [] }),
        load: async () => (await import("@/app/invoices/page")).default(sp({ tab: "review" })),
      },
    ],
  },
  {
    file: "models/page.tsx",
    variants: [{ name: "models", load: async () => (await import("@/app/models/page")).default() }],
  },
  {
    file: "portal-runs/page.tsx",
    variants: [
      { name: "runs", load: async () => (await import("@/app/portal-runs/page")).default() },
      { name: "empty", setup: () => (state.fx.runs = []), load: async () => (await import("@/app/portal-runs/page")).default() },
    ],
  },
  {
    file: "portal-runs/[id]/page.tsx",
    variants: [{ name: "run", load: async () => (await import("@/app/portal-runs/[id]/page")).default({ params: p({ id: ID }) }) }],
  },
  {
    file: "portal/page.tsx",
    allow: PORTAL_ALLOWS,
    variants: [
      { name: "no link", load: async () => (await import("@/app/portal/page")).default(sp()) },
      { name: "failed", load: async () => (await import("@/app/portal/page")).default(sp({ t: SESSION.tenantId, e: "1" })) },
    ],
  },
  {
    file: "portal/loads/page.tsx",
    allow: PORTAL_ALLOWS,
    variants: [
      { name: "search", load: async () => (await import("@/app/portal/loads/page")).default(sp({ q: "BR-L10247" })) },
      { name: "no search", load: async () => (await import("@/app/portal/loads/page")).default(sp()) },
    ],
  },
  {
    file: "portal/loads/[reference]/page.tsx",
    allow: PORTAL_ALLOWS,
    variants: [
      { name: "load", load: async () => (await import("@/app/portal/loads/[reference]/page")).default({ params: p({ reference: "FFE-104233" }) }) },
      {
        name: "missing",
        setup: () => (state.fx.portalDetail = null),
        load: async () => (await import("@/app/portal/loads/[reference]/page")).default({ params: p({ reference: "FFE-000000" }) }),
      },
    ],
  },
  {
    file: "records/advances/[id]/page.tsx",
    variants: [{ name: "record", load: async () => (await import("@/app/records/advances/[id]/page")).default({ params: p({ id: ID }) }) }],
  },
  {
    file: "records/customer_payments/[id]/page.tsx",
    variants: [
      { name: "record", load: async () => (await import("@/app/records/customer_payments/[id]/page")).default({ params: p({ id: ID }) }) },
    ],
  },
  {
    file: "records/customers/[id]/page.tsx",
    variants: [{ name: "record", load: async () => (await import("@/app/records/customers/[id]/page")).default({ params: p({ id: ID }) }) }],
  },
  {
    file: "records/drivers/[id]/page.tsx",
    variants: [
      { name: "record", load: async () => (await import("@/app/records/drivers/[id]/page")).default({ params: p({ id: ID }) }) },
      {
        name: "no paystubs or advances",
        setup: () => (state.fx.driverRecord = { ...fx.DRIVER_RECORD, settlements: [], advances: [], ownInsurance: false, activeTo: "2026-09-30" }),
        load: async () => (await import("@/app/records/drivers/[id]/page")).default({ params: p({ id: ID }) }),
      },
    ],
  },
  {
    file: "records/invoices/[id]/page.tsx",
    variants: [
      ...REVIEW_CASES.map(([name, view]) => ({
        name,
        setup: () => (state.fx.invoiceReview = view),
        load: async () => (await import("@/app/records/invoices/[id]/page")).default({ params: p({ id: ID }) }),
      })),
    ],
  },
  {
    file: "records/loads/[id]/page.tsx",
    variants: [{ name: "record", load: async () => (await import("@/app/records/loads/[id]/page")).default({ params: p({ id: ID }) }) }],
  },
  {
    file: "settlements/page.tsx",
    variants: [
      { name: "week", load: async () => (await import("@/app/settlements/page")).default(sp()) },
      {
        name: "nothing clean, waiting for the second check",
        setup: () => (state.fx.settlementsView = { ...fx.SETTLEMENTS_VIEW, clean: { items: [], totalCents: 0 }, awaitingAuditor: 2 }),
        load: async () => (await import("@/app/settlements/page")).default(sp()),
      },
      {
        name: "nothing clean",
        setup: () => (state.fx.settlementsView = { ...fx.SETTLEMENTS_VIEW, clean: { items: [], totalCents: 0 } }),
        load: async () => (await import("@/app/settlements/page")).default(sp()),
      },
      {
        name: "open week with no paystubs",
        setup: () => (state.fx.settlementsView = { ...fx.SETTLEMENTS_VIEW, rows: [], clean: { items: [], totalCents: 0 }, exemptDrivers: [] }),
        load: async () => (await import("@/app/settlements/page")).default(sp()),
      },
      {
        name: "paid week",
        setup: () =>
          (state.fx.settlementsView = {
            ...fx.SETTLEMENTS_VIEW,
            period: fx.SETTLEMENTS_VIEW.periods[1],
            rows: [],
            clean: { items: [], totalCents: 0 },
          }),
        load: async () => (await import("@/app/settlements/page")).default(sp({ period: fx.SETTLEMENTS_VIEW.periods[1].id })),
      },
      {
        name: "no pay weeks",
        setup: () => (state.fx.settlementsView = { ...fx.SETTLEMENTS_VIEW, periods: [], period: null, rows: [], exemptDrivers: [] }),
        load: async () => (await import("@/app/settlements/page")).default(sp()),
      },
    ],
  },
  {
    file: "records/settlements/[id]/page.tsx",
    variants: [
      ...SETTLEMENT_CASES.map(([name, view]) => ({
        name,
        setup: () => (state.fx.settlementRecord = view),
        load: async () => (await import("@/app/records/settlements/[id]/page")).default({ params: p({ id: ID }) }),
      })),
    ],
  },
  {
    file: "batches/[id]/page.tsx",
    variants: (["draining", "done", "partial"] as const).map((status) => ({
      name: status,
      setup: () =>
        (state.fx.batchRecord = {
          ...fx.BATCH_RECORD,
          status,
          finishedAt: status === "draining" ? null : "2026-10-27T15:05:00.000Z",
        }),
      load: async () => (await import("@/app/batches/[id]/page")).default({ params: p({ id: ID }) }),
    })),
  },
  {
    file: "settings/accounting/page.tsx",
    variants: [
      { name: "connected", load: async () => (await import("@/app/settings/accounting/page")).default(sp()) },
      { name: "not connected", setup: () => (state.fx.qbo = null), load: async () => (await import("@/app/settings/accounting/page")).default(sp()) },
      ...["connected", "disconnected", "forbidden", "not_configured", "expired", "not_allowed", "declined", "disabled"].map((qbo) => ({
        name: `note ${qbo}`,
        load: async () => (await import("@/app/settings/accounting/page")).default(sp({ qbo })),
      })),
    ],
  },
  {
    file: "settings/demo/page.tsx",
    variants: [{ name: "preview", load: async () => (await import("@/app/settings/demo/page")).default() }],
  },
  {
    file: "sign-in/page.tsx",
    variants: [
      { name: "form", load: async () => (await import("@/app/sign-in/page")).default({ searchParams: p({}) }) },
      { name: "invalid", load: async () => (await import("@/app/sign-in/page")).default({ searchParams: p({ error: "invalid" }) }) },
      { name: "unavailable", load: async () => (await import("@/app/sign-in/page")).default({ searchParams: p({ error: "unavailable" }) }) },
    ],
  },
  {
    file: "sweep/page.tsx",
    variants: [{ name: "home", load: async () => (await import("@/app/sweep/page")).default() }],
  },
  {
    file: "sweep/[id]/page.tsx",
    variants: [
      { name: "run", load: async () => (await import("@/app/sweep/[id]/page")).default({ params: p({ id: ID }) }) },
      {
        name: "second check found nothing more",
        setup: () =>
          (state.fx.sweepPage = {
            ...fx.SWEEP_PAGE,
            fanout: {
              ...fx.SWEEP_FANOUT,
              reconcile: {
                ...fx.SWEEP_FANOUT.reconcile,
                counts: { engine: 0, agreed: 0, engine_only: 0, spark_only: 0, drivers_checked: 1, drivers_unchecked: 0 },
                summary: null,
                disagreements: [],
              },
            },
          }),
        load: async () => (await import("@/app/sweep/[id]/page")).default({ params: p({ id: ID }) }),
      },
      {
        name: "second check skipped",
        setup: () =>
          (state.fx.sweepPage = {
            ...fx.SWEEP_PAGE,
            fanout: { ...fx.SWEEP_FANOUT, status: "skipped_daily_cap", checks: [], reconcile: { counts: null, summary: null, disagreements: [], turnId: null } },
          }),
        load: async () => (await import("@/app/sweep/[id]/page")).default({ params: p({ id: ID }) }),
      },
      {
        name: "second check stopped",
        setup: () => (state.fx.sweepPage = { ...fx.SWEEP_PAGE, fanout: { ...fx.SWEEP_FANOUT, status: "plan_skipped", finished: false } }),
        load: async () => (await import("@/app/sweep/[id]/page")).default({ params: p({ id: ID }) }),
      },
    ],
  },
  {
    file: "sweep/fuel/page.tsx",
    variants: [
      { name: "findings", load: async () => (await import("@/app/sweep/fuel/page")).default(), shows: FUEL_LABELS.fuel_duplicate },
      {
        name: "never checked",
        setup: () => (state.fx.fuelPage = { lastRun: null, needYou: 0, rows: [] }),
        load: async () => (await import("@/app/sweep/fuel/page")).default(),
        shows: FUEL_PAGE_WORDS.neverTitle,
      },
      {
        name: "nothing found",
        setup: () => (state.fx.fuelPage = { lastRun: fx.FUEL_RUN, needYou: 0, rows: [] }),
        load: async () => (await import("@/app/sweep/fuel/page")).default(),
        shows: FUEL_PAGE_WORDS.emptyTitle,
      },
      {
        name: "checking",
        setup: () => (state.fx.fuelPage = { ...fx.FUEL_PAGE, lastRun: { ...fx.FUEL_RUN, status: "running", finishedAt: null } }),
        load: async () => (await import("@/app/sweep/fuel/page")).default(),
        shows: FUEL_PAGE_WORDS.running,
      },
      {
        name: "last check did not finish",
        setup: () => (state.fx.fuelPage = { ...fx.FUEL_PAGE, lastRun: { ...fx.FUEL_RUN, status: "failed" } }),
        load: async () => (await import("@/app/sweep/fuel/page")).default(),
        shows: FUEL_PAGE_WORDS.failed,
      },
    ],
  },
  {
    file: "voice-notes/page.tsx",
    variants: [
      { name: "list", load: async () => (await import("@/app/voice-notes/page")).default() },
      { name: "empty", setup: () => (state.fx.voiceList = []), load: async () => (await import("@/app/voice-notes/page")).default() },
    ],
  },
  {
    file: "voice-notes/[id]/page.tsx",
    variants: Object.keys(VOICE_STATUS_WORDS).map((status) => ({
      name: status,
      setup: () => (state.fx.voiceDetail = { ...fx.VOICE_DETAIL, status }),
      load: async () => (await import("@/app/voice-notes/[id]/page")).default({ params: p({ id: ID }) }),
    })),
  },
  // The route files that are not a page.tsx.
  {
    file: "not-found.tsx",
    failureScreen: true,
    variants: [
      { name: "signed out", load: async () => (await import("@/app/not-found")).default() },
      {
        name: "signed in, inside the menu",
        setup: () => (state.session = SESSION),
        load: async () => (await import("@/app/not-found")).default(),
        shows: fx.TENANT.name,
      },
    ],
  },
  {
    file: "portal/layout.tsx",
    variants: [
      {
        name: "around a portal page",
        load: async () => (await import("@/app/portal/layout")).default({ children: <p>Your loads</p> }),
      },
    ],
  },
  loading("documents/loading.tsx", () => import("@/app/documents/loading")),
  loading("documents/[id]/loading.tsx", () => import("@/app/documents/[id]/loading")),
  loading("driver-notes/loading.tsx", () => import("@/app/driver-notes/loading")),
  loading("driver-notes/[settlementId]/view/loading.tsx", () => import("@/app/driver-notes/[settlementId]/view/loading")),
  loading("invoices/loading.tsx", () => import("@/app/invoices/loading")),
  loading("models/loading.tsx", () => import("@/app/models/loading")),
  loading("pay/[periodId]/notes/loading.tsx", () => import("@/app/pay/[periodId]/notes/loading")),
  loading("records/loading.tsx", () => import("@/app/records/loading")),
  loading("sweep/loading.tsx", () => import("@/app/sweep/loading")),
  loading("sweep/fuel/loading.tsx", () => import("@/app/sweep/fuel/loading")),
];

// Route files this test does not render as a page, each with the reason. Keep it short: a new page
// belongs above.
const LISTED: Readonly<Record<string, string>> = {
  "layout.tsx":
    "The document around every page: it puts each one in the html shell and the toast holder and shows no words on the page. Its tab title and description are scanned below.",
  "records/settlement_periods/[id]/page.tsx":
    "Shows nothing of its own: it only sends a pay week's link on to that week on the Settlements page, which is rendered above.",
  "design/page.tsx":
    "The builders' design reference: it shows status codes, token names and sample states on purpose, and no carrier or driver reaches it from the app's menu.",
};

// The App Router's own file names: each one is a screen, or wraps one, when its route is shown.
const ROUTE_FILE = /^(page|layout|template|loading|not-found|error|global-error|global-not-found|default|forbidden|unauthorized)\.(tsx|jsx|ts|js)$/;

function routeFiles(): string[] {
  const root = join(process.cwd(), "src", "app");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (ROUTE_FILE.test(e.name)) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

describe("every page is covered", () => {
  it("renders or lists every route file under src/app (pages, layouts, loading and not-found screens), and names none that is gone", () => {
    const files = routeFiles();
    const rendered = PAGES.map((c) => c.file);
    const covered = new Set([...rendered, ...Object.keys(LISTED)]);
    expect(files.filter((f) => !covered.has(f)), "a new route file: render it in PAGES or list it in LISTED with the reason").toEqual([]);
    expect([...covered].filter((f) => !files.includes(f))).toEqual([]);
    expect(rendered.filter((f) => Object.hasOwn(LISTED, f))).toEqual([]);
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});

// The titles a page shows instead of itself: a failed read, a missing record, a switched-off feature.
// A variant that lands on one of these would scan the failure screen and leave the page's own words
// unchecked, so every page variant must render without them. The budget and paused-job titles are left
// out on purpose: those belong to one agent turn, and Home shows a paused turn from its fixtures.
const READ_FAILURES = ERROR_CATEGORIES.filter((c) => c !== "budget" && c !== "job_cap");

function failureTitles(): string[] {
  const titles = READ_FAILURES.map((category) => {
    const { container } = render(<ErrorState category={category} />);
    const title = container.querySelector("p")?.textContent ?? "";
    cleanup();
    return title;
  });
  const { container } = render(<PageNotFound />);
  titles.push(container.querySelector("h1")?.textContent ?? "");
  cleanup();
  return titles;
}

describe("no internal word on any page", () => {
  let failures: string[] = [];
  beforeAll(() => {
    failures = failureTitles();
    expect(failures.every((t) => t.length > 0)).toBe(true);
  });

  for (const c of PAGES) {
    for (const v of c.variants) {
      it(`${c.file} (${v.name})`, async () => {
        v.setup?.();
        const container = await renderPage(v.load);
        const text = container.textContent ?? "";
        expect(text.trim().length).toBeGreaterThan(0);
        if (v.shows) expect(text).toContain(v.shows);
        if (c.failureScreen) {
          expect(failures.some((t) => text.includes(t)), "the failure screen shows its title").toBe(true);
        } else {
          expect(failures.filter((t) => text.includes(t)), "the page fell back to a failure screen").toEqual([]);
          expect(text, "the page fell back to a switched-off screen").not.toMatch(/off for this carrier/);
        }
        expect(scan(container, c.allow)).toEqual([]);
      });
    }
  }
});

// The root layout renders the html document itself, which cannot sit inside a test's container, so
// it is rendered to markup and read as a document: its tab title and description, and what it puts
// around a page.
describe("no internal word in the document around every page", () => {
  it("layout.tsx", async () => {
    const { default: RootLayout, metadata } = await import("@/app/layout");
    expect(hitsIn(`${String(metadata.title)}\n${String(metadata.description)}`, new Set())).toEqual([]);
    const html = renderToStaticMarkup(
      <RootLayout>
        <p>Your pay week</p>
      </RootLayout>,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.body.textContent).toContain("Your pay week");
    expect(scan(doc.documentElement)).toEqual([]);
  });
});

// ---- The shared components, in every state they can show ----

const STATUSES: ProposalStatus[] = ["proposed", "approved", "rejected", "executing", "done", "failed", "expired", "unknown"];
const AUDITS: (ProposalAudit | undefined)[] = [
  undefined,
  { state: "checking" },
  { state: "pass" },
  { state: "concerns", text: "The amount is higher than this driver's usual advance." },
  { state: "block", text: "No load backs this advance." },
  { state: "block", text: "No load backs this advance.", override: { reason: "Driver called the office", byLabel: "Admin", at: "Oct 28, 10:00 AM" } },
  { state: "unknown" },
  { state: "off" },
  { state: "budget" },
];

describe("no internal word on a card", () => {
  for (const [name, sample] of Object.entries({ advance: ADVANCE_PROPOSAL, payment: PAYMENT_PROPOSAL, move: MOVE_PROPOSAL })) {
    for (const status of STATUSES) {
      it(`${name} card, ${status}, every second-check state`, async () => {
        for (const audit of AUDITS) {
          for (const confirming of [false, true]) {
            const { container, unmount } = render(
              <ProposalCard {...sample} status={status} audit={audit} onApprove={() => {}} onReject={() => {}} canResume initialConfirming={confirming} />,
            );
            expect(scan(container)).toEqual([]);
            unmount();
          }
        }
      });
    }
  }
});

describe("no internal word on a paystub", () => {
  it("the sample paystubs", () => {
    for (const stub of [PAYSTUB, SHORT_WEEK_PAYSTUB]) {
      const { container, unmount } = render(<Paystub {...stub} />);
      expect(scan(container)).toEqual([]);
      unmount();
    }
  });

  it("every line label the seed writes, for both carriers", () => {
    const seen = new Map<string, { kind: string; label: string }>();
    for (const carrier of DEMO_CARRIERS) {
      for (const l of buildCarrierPlan(carrier, DEMO_ANCHOR).rows.settlement_lines) seen.set(`${l.kind}|${l.label}`, { kind: l.kind, label: l.label });
    }
    const lines = [...seen.values()].map((l, i) => ({ seq: i + 1, kind: l.kind, label: l.label, amountCents: 100, sources: [] }));
    expect(lines.length).toBeGreaterThan(10);
    const { container } = render(<Paystub {...PAYSTUB} lines={lines} />);
    expect(scan(container)).toEqual([]);
  });
});

function sampleRow(name: ReportName): ReportRow {
  const row: ReportRow = {};
  for (const c of REPORT_COLUMNS[name]) {
    row[c.key] =
      c.kind === "cents" ? 123_456 : c.kind === "int" ? 3 : c.kind === "pct" ? 1_234 : c.kind === "date" ? "2026-10-19" : c.kind === "ref" ? { table: "drivers", id: ID, label: "BR-D07" } : "Rosa Delgado";
  }
  return row;
}

function result(name: ReportName, over: Partial<ReportResult> = {}): ReportResult {
  const cents = REPORT_COLUMNS[name].filter((c) => c.kind === "cents").map((c) => c.key);
  const totals = Object.fromEntries(cents.map((k) => [k, 123_456]));
  return {
    report: name,
    title: REPORT_TITLES[name],
    asOf: "2026-11-02",
    args: {},
    period: { start: "2026-10-26", end: "2026-11-01" },
    columns: [...REPORT_COLUMNS[name]],
    rows: [sampleRow(name)],
    totals,
    subtotals: [{ label: "Company drivers", totals }],
    truncated: true,
    rowsTotal: 80,
    ...over,
  };
}

describe("no internal word in a report table", () => {
  for (const name of REPORT_NAMES) {
    it(name, () => {
      const loads: ReportLoad[] = [
        { state: "loading" },
        { state: "error", category: "forbidden" },
        { state: "error", category: "unreadable" },
        { state: "ready", result: result(name) },
        { state: "ready", result: result(name, { rows: [], totals: undefined, subtotals: undefined, truncated: false, rowsTotal: 0, emptyReason: "no_rows" }) },
        { state: "ready", result: result(name, { rows: [], totals: undefined, subtotals: undefined, truncated: false, rowsTotal: 0, emptyReason: "no_pay_run" }) },
      ];
      for (const load of loads) {
        const { container, unmount } = render(<DataTable {...reportTable(name, load)} />);
        expect(scan(container)).toEqual([]);
        unmount();
      }
    });
  }
});

describe("no internal word on a status pill", () => {
  it("every known status code", () => {
    const codes = new Set<string>([
      ...BADGE_STATUSES,
      ...Object.values(SUBJECT_STATUSES).flat(),
      ...["reserved", "sent", "confirmed", "failed", "unknown"],
      ...["queued", "running", "waiting_approval", "done", "failed", "declined", "stopped"],
    ]);
    for (const code of codes) {
      const { container, unmount } = render(<StatusBadge status={code} />);
      expect(container.textContent?.trim()).not.toBe("");
      expect(scan(container), code).toEqual([]);
      unmount();
    }
  });
});

describe("no internal word in a chat answer or its trace", () => {
  it("every step label a tool or the agent writes", () => {
    const labels = [
      ...new Set([
        ...Object.values(TOOL_REGISTRY).map((t) => t.label),
        "Asking Muse Wonder to form the proposal",
        "Preparing a proposal card",
      ]),
    ];
    const turn: TurnView = {
      ...fx.TURNS[0],
      steps: labels.map((label, i) => ({ id: `step-${i}`, seq: i + 1, kind: "tool", label, state: "done" })),
      proposals: [...fx.PROPOSALS, ...fx.INVOICE_PROPOSALS],
    };
    const failed = fx.TURNS[1];
    const messages = toMessages([turn, failed, { ...failed, id: "turn-budget", error: "budget" }, { ...failed, id: "turn-timeout", error: "timeout" }], {}, {}, undefined, {
      on: true,
      checking: {},
      timezone: fx.TENANT.timezone,
    });
    const { container } = render(<ChatThread messages={messages} composer={{}} />);
    expect(scan(container)).toEqual([]);
  });

  it("the trace, for the answer and for a card", async () => {
    render(
      <>
        <HowWorkedOut turnId={SAMPLE_TURN_ID} load={async () => ({ trace: sampleTrace() })} />
        <HowWorkedOut turnId={SAMPLE_TURN_ID} proposalId={SAMPLE_PROPOSAL_ID} load={async () => ({ trace: sampleTrace() })} />
      </>,
    );
    for (const button of screen.getAllByRole("button", { name: /How this was worked out/i })) {
      await act(async () => {
        fireEvent.click(button);
      });
    }
    const body = document.body;
    expect(body.textContent).toMatch(/Muse/);
    expect(scan(body)).toEqual([]);
  });
});

describe("no internal word in a shared state", () => {
  it("every error, the empty, loading, off and not found states", () => {
    const { container } = render(
      <>
        {ERROR_CATEGORIES.map((c) => (
          <ErrorState key={c} category={c} />
        ))}
        <EmptyState title="No advances yet" body="A driver's request shows here." />
        <LoadingState label="Loading your advances" />
        <FeatureOff name="Advances" plural />
        <FeatureOff name="Pay sweep" />
        <PageNotFound />
      </>,
    );
    expect(scan(container)).toEqual([]);
  });
});

describe("no internal word on a pay week's buttons and notes", () => {
  it("the Approve all clean sheet, opened", async () => {
    // jsdom has no modal dialog; this stands in for the browser's, as the sheet's own test does.
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    try {
      const items = fx.SETTLEMENTS_VIEW.clean.items;
      render(<ApproveAll periodId={fx.SETTLEMENTS_VIEW.periods[0].id} items={items} totalCents={fx.SETTLEMENTS_VIEW.clean.totalCents} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Approve all clean/ }));
      });
      expect(document.body.textContent).toContain("second check agreed");
      expect(scan(document.body)).toEqual([]);
    } finally {
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    }
  });

  it("the note after Continue on a batch", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ confirmed: 2, failed: 1, unknown: 1, remaining: 3 }), { status: 200 }));
    try {
      render(<ContinueBatch batchId={fx.BATCH_RECORD.id} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      });
      expect(screen.getByRole("status").textContent).toBe("2 confirmed, 1 failed, 1 not confirmed yet, 3 still to send.");
      expect(scan(document.body)).toEqual([]);
    } finally {
      vi.stubGlobal("fetch", () => new Promise(() => {}));
    }
  });

  it("every outcome, park reason, exception, money leg and button note", () => {
    const states = ["confirmed", "sent", "reserved", "unknown", "failed", "not_started", "attempts_used"];
    const words = [
      ...Object.values(SETTLEMENT_OUTCOMES),
      ...Object.values(PARK_LABELS),
      ...Object.values(EXCEPTION_LABELS),
      ...Object.values(LEG_LABELS),
      doneNote("run", { counts: { drafts: 3, exceptions: 1, locked: 1, truncated: true } }),
      ...states.map((st) => doneNote("retry", { state: st })),
      ...states.map((st) => doneNote("post", { legs: { bill: st, billPayment: st } })),
    ];
    const { container } = render(
      <ul>
        {words.map((w, n) => (
          <li key={n}>{w}</li>
        ))}
      </ul>,
    );
    expect(scan(container)).toEqual([]);
  });
});

// The fuel checks page's parts that show only after a click: each row's detail (the dismiss picker
// open on a row that needs a person), every note an action can leave, and every fixed line.
describe("no internal word on a fuel check's detail and notes", () => {
  const showFuel = () => render(<FuelChecks page={fx.FUEL_PAGE} auditorOn timezone={fx.TENANT.timezone} />);
  const click = async (name: string | RegExp) => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  };
  // A row's own button in the table, by its place: it reads "See details: ..." or "Hide details: ...".
  const toggleRow = async (n: number) => {
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /^(See|Hide) details: / })[n]);
    });
  };
  // Every POST answers with this refusal category; with none, it succeeds.
  const answer = (error: string | null) =>
    vi.stubGlobal("fetch", async () =>
      error === null ? new Response(JSON.stringify({ ok: true }), { status: 200 }) : new Response(JSON.stringify({ error }), { status: 409 }),
    );

  it("every row's detail, opened, with the dismiss picker on a row that needs a person", async () => {
    showFuel();
    const hits: Hit[] = [];
    for (const [n, row] of fx.FUEL_PAGE.rows.entries()) {
      await toggleRow(n);
      expect(screen.getByRole("region").textContent).toContain(row.sentence);
      if (row.status === "open") await click(FUEL_PAGE_WORDS.dismiss);
      hits.push(...scan(document.body));
      await toggleRow(n);
    }
    expect(hits).toEqual([]);
  });

  it("every note after checking, proposing, dismissing, approving and rejecting", async () => {
    showFuel();
    const hits: Hit[] = [];
    const seen = new Set<string>();
    const read = () => {
      for (const s of screen.queryAllByRole("status")) if (s.textContent) seen.add(s.textContent);
      hits.push(...scan(document.body));
    };
    try {
      for (const error of ["busy", "failed", "unknown", "not_configured", "refused"]) {
        answer(error);
        await click(FUEL_PAGE_WORDS.run);
        read();
      }
      await toggleRow(0);
      for (const error of [null, "live_exists", "changed", "no_open_period", "already_decided", "not_configured", "unknown", "refused"]) {
        answer(error);
        await click(/^Propose a pay correction/);
        read();
      }
      for (const error of ["changed", "unknown", "refused"]) {
        answer(error);
        await click(FUEL_PAGE_WORDS.dismiss);
        await click(FUEL_PAGE_WORDS.dismissConfirm);
        read();
        await click(FUEL_PAGE_WORDS.cancel);
      }
      await toggleRow(0);
      await toggleRow(fx.FUEL_PAGE.rows.findIndex((r) => r.status === "proposed" && r.proposal?.status === "proposed"));
      const approveErrors = ["already_decided", "expired", "role", "auditor_required", "override_required", "stale", "needs_confirm"];
      for (const error of [...approveErrors, "not_found", "not_executable", "refused", "unknown"]) {
        answer(error);
        if (!screen.queryByRole("button", { name: "Confirm" })) await click(/^Approve/);
        await click("Confirm");
        read();
      }
      await click("Cancel");
      for (const error of ["refused", "unknown"]) {
        answer(error);
        await click("Reject");
        read();
      }
    } finally {
      vi.stubGlobal("fetch", () => new Promise(() => {}));
    }
    // Each action left its own note, so every path above was read.
    expect(seen.size).toBeGreaterThanOrEqual(20);
    expect(hits).toEqual([]);
  });

  it("every label, status, hover help, no-change reason, photo line and run line", () => {
    const words = [
      ...Object.values(FUEL_PAGE_WORDS),
      ...Object.values(FUEL_LABELS),
      ...Object.values(FUEL_STATUS_WORDS),
      ...Object.values(DISMISS_WORDS),
      ...FUEL_CHECK_NAMES.map((c) => fuelHelp(c, 250, 286_400)),
      ...NO_SUGGESTION_REASONS.flatMap((r) => [noSuggestionLine(r, 14_014), noSuggestionLine(r, null)]),
      ...[null, "same", "different"].flatMap((verdict) =>
        ["high", "medium", "low", null].map((confidence) => compareLine({ verdict, confidence, category: null })),
      ),
      ...["no_photos", "budget", "timeout", "unreadable", null].map((category) => compareLine({ verdict: "unknown", confidence: null, category })),
      runLine(1, 1),
      runLine(464, 4),
    ];
    const { container } = render(
      <ul>
        {words.map((w, n) => (
          <li key={n}>{w}</li>
        ))}
      </ul>,
    );
    expect(scan(container)).toEqual([]);
  });
});

describe("the scan itself", () => {
  const el = (html: string) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div;
  };

  it("finds a word in text, in an aria label and in a title", () => {
    expect(scan(el("<p>Approve the proposal</p>")).map((h) => h.word)).toEqual(["proposal"]);
    expect(scan(el('<button aria-label="Tenant menu">x</button>')).map((h) => h.word)).toEqual(["tenant"]);
    expect(scan(el('<span title="Auditor verdict">x</span>')).map((h) => h.word)).toEqual(["verdict", "auditor"]);
  });

  it("reads plurals and the forms the design's pattern missed", () => {
    const words = (s: string) => scan(el(`<p>${s}</p>`)).map((h) => h.word);
    expect(words("3 proposals")).toEqual(["proposal"]);
    expect(words("Idempotency key")).toEqual(["idempotency"]);
    expect(words("Accessorials")).toEqual(["accessorial"]);
    expect(words("America/New_York")).toEqual(["America/"]);
  });

  it("finds a stored timestamp, not only a bare date, and not a longer number", () => {
    const words = (s: string) => scan(el(`<span>${s}</span>`)).map((h) => h.word);
    expect(words("2026-10-28T15:00:00.000Z")).toEqual(["ISO date"]);
    expect(words("2026-10-28 15:04:00")).toEqual(["ISO date"]);
    expect(words("2026-10-281")).toEqual([]);
  });

  it("keeps two cells apart, so a date is found next to a number", () => {
    expect(scan(el("<span>BR-INV-10244</span><span>2026-10-20</span>")).map((h) => h.word)).toEqual(["ISO date"]);
  });

  it("lets the word accessorial through only in a Term's own help text", () => {
    const help = TERMS["extra-charges"];
    expect(help).toMatch(/accessorials/);
    expect(scan(el(`<span role="tooltip" hidden>${help}</span>`))).toEqual([]);
    expect(scan(el('<span role="tooltip">Accessorials</span>')).map((h) => h.word)).toEqual(["accessorial"]);
    expect(scan(el(`<span role="tooltip">${help} (rules engine)</span>`)).map((h) => h.word)).toEqual(["rules engine", "accessorial"]);
  });

  it("does not flag the plain words", () => {
    expect(scan(el("<p>Second check passed. Waiting to send. Credit on account. Oct 19, 2026. Eastern time. Spent so far this demo: $0.00 of $2.00</p>"))).toEqual([]);
  });
});
