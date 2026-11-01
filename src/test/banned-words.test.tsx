// @vitest-environment jsdom
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLauncher } from "@/components/agent/agent-launcher";
import { defaultSuggestions, withPaystubSuggestion } from "@/components/agent/suggestions";
import { greetingLine } from "@/components/agent/words";
import { weekEnding } from "@/components/agent/page-focus";
import { proposalCardFrom } from "@/components/agent/proposal-card-from";
import { reportTable, type ReportLoad } from "@/components/agent/report-table";
import { toMessages } from "@/components/agent/turn-view";
import { ChatThread } from "@/components/app/chat-thread";
import { DataTable } from "@/components/app/data-table";
import { DemoBanner } from "@/components/app/demo-banner";
import { TestModeBanner } from "@/components/app/test-mode-banner";
import { TopBar } from "@/components/app/top-bar";
import { Paystub } from "@/components/app/paystub";
import { ProposalCard, type ProposalAudit, type ProposalStatus, type ProposalVerification } from "@/components/app/proposal-card";
import { EmptyState, ERROR_CATEGORIES, ErrorState, FeatureOff, LoadingState, PageNotFound } from "@/components/app/states";
import { BADGE_STATUSES, StatusBadge } from "@/components/app/status-badge";
import { ViewerRoleProvider } from "@/components/app/viewer-role";
import { ToastProvider } from "@/components/app/toast";
import { ApproveAll } from "@/components/settlements/approve-all";
import { ContinueBatch } from "@/components/settlements/continue-batch";
import { OUT_OF_DATE } from "@/components/cash/friday-pay";
import { doneNote } from "@/components/settlements/action-button";
import { FuelChecks } from "@/components/fuel/fuel-checks";
import { RuleChangeCards, type RuleChangeCard } from "@/components/pay-rules/rule-change-cards";
import { HowWorkedOut } from "@/components/trace/how-worked-out";
import { WriteBrief } from "@/components/profit/write-brief";
import { WriteReview } from "@/components/quarter/write-review";
import { ADVANCE_PROPOSAL, MOVE_PROPOSAL, PAYMENT_PROPOSAL, PAYSTUB, SHORT_WEEK_PAYSTUB } from "@/app/design/sample-data";
import { NotesBoard } from "@/app/memory/notes-board";
import { CardsBoard, type BoardRow } from "@/components/pay-cards/cards-board";
import { flags } from "@/config/flags";
import { TOOL_REGISTRY } from "@/lib/agent/gateway/registry";
import { FOUND_TEXT, STOPPED_TEXT, type ProposalView, type TurnView } from "@/lib/agent/view";
import type { Session } from "@/lib/auth/claims";
import { reasonSentence } from "@/lib/agent/reasons";
import { ANSWER_PILL, ANSWER_REASONS, VERIFY_LINES } from "@/lib/agent/verify";
import { refusalWords as briefRefusalWords, writeOutcome } from "@/lib/briefs/words";
import { reviewOutcome, reviewRefusalWords } from "@/lib/briefs/quarter-words";
import {
  BILL_CATEGORY_WORDS,
  BILL_STATUS_WORDS,
  CASH_CARD_NOTICES,
  CHECK_NOT_CONFIRMED,
  CHECK_NOTICE,
  explainMissing,
  PAYER_WORDS,
  RECEIPT_STATUS_WORDS,
} from "@/lib/cash/labels";
import {
  approvedWords,
  DECIDE_ERROR_WORDS,
  DRAFT_ERROR_WORDS,
  draftedWords,
  EMAIL_UNCONFIRMED_WORDS,
  REFUSAL_WORDS,
  refusalWords,
  REMINDER_STATUS_WORDS,
  stillWaitingWords,
  TONE_HELP,
  TONE_WORDS,
  UNCONFIRMED_DECISION_WORDS,
} from "@/lib/collections/words";
import type { BreakView } from "@/lib/data/card-recon";
import { DbError, type Queryable } from "@/lib/db";
import type { InvoiceReviewView } from "@/lib/invoices/review-read";
import * as factoringWords from "@/lib/factoring/words";
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
import { RULE_KEYS, RULES, formatValue, labelFor } from "@/lib/pay-rules/rules";
import * as payWords from "@/lib/pay-rules/words";
import { lookupNotice, lookupsLeftLine, pinnedFromLine, pinNext, pinNotice, pinQuestion, RATES_WORDS } from "@/lib/rates/words";
import { CARD_ERROR_FALLBACK, CARD_ERROR_WORDS, CARD_PILL_WORDS, CARD_REASON_WORDS, CARD_WORDS } from "@/lib/pay-cards/words";
import { INVOICE_REVIEW_STATUSES } from "@/lib/rules-engine";
import { FUEL_CHECK_NAMES, NO_SUGGESTION_REASONS } from "@/lib/rules-engine/fuel";
import type { HandPick } from "@/lib/recon/view";
import { HAND_PICK_WORDS } from "@/lib/recon/words";
import { REPORT_COLUMNS, REPORT_NAMES, REPORT_TITLES, type ReportName, type ReportResult, type ReportRow } from "@/lib/reports/types";
import { DEMO_ANCHOR } from "@/lib/seed/anchor";
import { DEMO_CARRIERS } from "@/lib/seed/carriers";
import { buildCarrierPlan } from "@/lib/seed/plan";
import { EXCEPTION_LABELS, LEG_LABELS, PARK_LABELS, SETTLEMENT_OUTCOMES } from "@/lib/settlements/labels";
import type { SettlementRecordView } from "@/lib/settlements/views";
import { endSweep, sweepChecklist, tickSweep } from "@/lib/sweep/checklist";
import { SAMPLE_PROPOSAL_ID, SAMPLE_TURN_ID, sampleTrace } from "@/lib/trace/sample";
import { NOTE_NOT_KEPT } from "@/lib/trace/steps";
import { NeedsYou } from "@/components/app/needs-you";
import { escalatedText } from "@/lib/agent/policy";
import { PROPOSAL_CHECK_WORDS } from "@/lib/agent/verify/required";
import { escalatedRow } from "@/lib/home/needs-you";
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
    // The home page's escalated-turns count, read while verification is on: none waiting.
    if (/^SELECT count\(\*\) AS n\s+FROM turns t\s+JOIN conversations c/.test(sql)) return [{ n: 0 }];
    // Settings > Demo's dispatch fault panel: a synthetic connection with every fault off.
    if (/FROM tms_connections/.test(sql)) return [{ system: "synthetic", faults: "{}" }];
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
vi.mock("@/app/sign-in/try-demo-action", () => ({ tryDemoAction: async () => {} }));
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
vi.mock("@/lib/home/today", () => ({ readTodayIntake: async () => get("todayIntake") }));
vi.mock("@/lib/home/money-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/home/money-flow")>()),
  readMoneyFlow: async () => get("moneyFlow"),
}));
vi.mock("@/lib/collections/view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/collections/view")>()),
  readCollectionsView: async () => get("collectionsView"),
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
// The card picture is drawn by the browser; here it is a fixed stand-in so the board's answers
// can be driven through fetch.
vi.mock("@/components/pay-cards/card-canvas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/pay-cards/card-canvas")>()),
  cardPng: async () => new Blob(["card"], { type: "image/png" }),
  blobBase64: async () => "Y2FyZA==",
}));
vi.mock("@/lib/pay-cards/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pay-cards/read")>()),
  readPeriodCards: async () => get("periodCards"),
  readDriverCard: async () => get("driverCard"),
}));
vi.mock("@/lib/recon/view", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/recon/view")>();
  return {
    ...real,
    readCardHome: async () => get("cardHome"),
    readCardBreak: async () => get("cardBreak"),
    // Only a difference that waits on a hand pick lists drivers, as the real read decides.
    readHandPick: async (_q: Queryable, b: BreakView) => (real.needsHandPick(b) ? get("cardHandPick") : null),
  };
});
vi.mock("@/lib/agent/gateway/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/gateway/store")>()),
  readEngineProposalViews: async () => get("invoiceProposals"),
  readAgentModelWeek: async () => get("week"),
  readRecentAgentTurns: async () => get("turns"),
  readWaitingRuleChangeViews: async () => get("ruleChanges"),
}));
// A recorded eval run, so the models page's eval card has rows to show when its switch is on.
vi.mock("@/lib/eval/latest", async (importOriginal) => {
  const { sampleEvalResults } = await import("@/lib/eval/test-fixtures");
  return { ...(await importOriginal<typeof import("@/lib/eval/latest")>()), latestResults: () => sampleEvalResults() };
});
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
vi.mock("@/lib/pay-rules/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pay-rules/read")>()),
  // An Error fixture stands for rules that could not be read whole.
  readPayRulesPage: async () => {
    const page = get<unknown>("payRulesPage");
    if (page instanceof Error) throw page;
    return page;
  },
  readNextWeekStart: async () => get("nextStart"),
}));
vi.mock("@/lib/rates/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rates/read")>()),
  readRatesPage: async () => get("ratesPage"),
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
vi.mock("@/lib/data/driver-insights", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/driver-insights")>()),
  readDriverInsightInput: async () => get("driverInsightInput"),
  readCardedDrivers: async () => new Set(get<string[]>("cardedDrivers")),
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
vi.mock("@/lib/money-codes/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/money-codes/read")>()),
  listMoneyCodes: async () => get("moneyCodes"),
  readMoneyCode: async () => get("moneyCode"),
}));
vi.mock("@/lib/money-codes/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/money-codes/request")>()),
  readRequestChoices: async () => get("codeChoices"),
}));
vi.mock("@/lib/briefs/view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/briefs/view")>()),
  readProfitView: async () => get("profitView"),
}));
vi.mock("@/lib/cash/view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cash/view")>()),
  readCashView: async () => get("cashView"),
  readVendorBill: async () => get("vendorBill"),
  readCashHome: async () => get("cashHome"),
}));
vi.mock("@/lib/memory/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/notes")>()),
  listNotes: async () => get("memoryNotes"),
  listNoteSubjects: async () => get("noteSubjects"),
}));
// The Memory board's saves answer what each test sets, so every refusal it can show is read.
const noteActions = vi.hoisted(() => ({
  addNoteAction: vi.fn(),
  editNoteAction: vi.fn(),
  keepNoteAction: vi.fn(),
  removeNoteAction: vi.fn(),
}));
vi.mock("@/app/memory/actions", () => noteActions);
vi.mock("@/lib/factoring/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/factoring/read")>()),
  listRequests: async () => get("factoringRequests"),
  readRequest: async () => get("factoringRequest"),
  readFactoredLine: async () => get("factoredLine"),
}));
vi.mock("@/lib/briefs/quarter-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/briefs/quarter-review")>()),
  readQuarterView: async () => get("quarterView"),
}));
vi.mock("@/lib/voice/read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice/read")>()),
  readVoiceList: async () => get("voiceList"),
  readVoiceDetail: async () => get("voiceDetail"),
}));
vi.mock("@/lib/records/views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/records/views")>()),
  readPayItemView: async () => get("payItemView"),
  readDriverDayView: async () => get("driverDayView"),
  readScheduleView: async () => get("scheduleView"),
  readExtraChargeLoadId: async () => get("extraChargeLoadId"),
}));
vi.mock("@/lib/help/hero-link", () => ({ readHeroLink: async () => get("heroLink") }));

function defaults(): Record<string, unknown> {
  return {
    drivers: fx.DRIVERS,
    advances: fx.ADVANCES,
    advanceRecord: fx.ADVANCE_RECORD,
    driverAdvances: fx.DRIVER_ADVANCES,
    identity: fx.IDENTITY,
    clips: fx.CLIPS,
    collectionsView: fx.COLLECTIONS_VIEW,
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
    periodCards: fx.PERIOD_CARDS,
    driverCard: null,
    invoiceProposals: fx.INVOICE_PROPOSALS,
    week: fx.WEEK,
    turns: fx.TURNS,
    spend: fx.SPEND,
    calls: fx.CALLS,
    day: fx.DAY,
    alerts: fx.ALERTS,
    sweepHome: fx.SWEEP_HOME,
    todayIntake: { documents: 3, voiceNotes: 1, messages: 2 },
    moneyFlow: [
      { start: "2026-10-19", end: "2026-10-25", inCents: 1_250_000, outCents: 980_000 },
      { start: "2026-10-26", end: "2026-11-01", inCents: 640_000, outCents: 1_010_000 },
    ],
    sweepPage: fx.SWEEP_PAGE,
    fuelPage: fx.FUEL_PAGE,
    ratesPage: fx.RATES_PAGE,
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
    driverInsightInput: fx.DRIVER_INSIGHT_INPUT,
    cardedDrivers: fx.CARDED_DRIVER_IDS,
    settlementRecord: fx.SETTLEMENT_RECORD,
    driverRecord: fx.DRIVER_RECORD,
    batchRecord: fx.BATCH_RECORD,
    paystubAsk: null,
    reviewQueue: fx.REVIEW_QUEUE,
    invoiceReview: fx.INVOICE_REVIEW,
    moneyCodes: fx.MONEY_CODES,
    moneyCode: fx.MONEY_CODE_DETAIL,
    codeChoices: fx.CODE_CHOICES,
    cardHome: fx.CARD_HOME,
    cardBreak: fx.CARD_BREAKS[0],
    cardHandPick: fx.CARD_HAND_PICK,
    payRulesPage: fx.PAY_RULES_PAGE,
    nextStart: fx.NEXT_START,
    ruleChanges: fx.RULE_CHANGES,
    payItemView: fx.PAY_ITEM_CASES[0][1],
    driverDayView: fx.DRIVER_DAY_CASES[0][1],
    scheduleView: fx.SCHEDULE_CASES[0][1],
    extraChargeLoadId: null,
    heroLink: fx.HERO_LINK_DRAFT,
    profitView: fx.PROFIT_VIEW,
    cashView: fx.CASH_VIEW,
    vendorBill: fx.VENDOR_BILL,
    cashHome: null,
    memoryNotes: fx.MEMORY_NOTES,
    noteSubjects: fx.NOTE_SUBJECTS,
    factoringRequests: fx.FACTORING_REQUESTS,
    factoringRequest: fx.FACTORING_REQUEST,
    factoredLine: null,
    quarterView: fx.QUARTER_VIEW,
  };
}

// Every switch on, so each page shows its working state, not the off page. Money codes is a switch
// with settings, so only its own enabled is turned on.
const SWITCHES = Object.keys(flags).filter((k) => typeof (flags as Record<string, unknown>)[k] === "boolean");
const saved = Object.fromEntries(SWITCHES.map((k) => [k, (flags as Record<string, unknown>)[k]]));
// Factoring's switch is a field of its own settings object, so it is turned on beside the others.
const savedFactoring = flags.factoring.enabled;
const savedCodes = { ...flags.moneyCodes };
beforeAll(() => {
  for (const k of SWITCHES) (flags as Record<string, unknown>)[k] = true;
  flags.factoring.enabled = true;
  flags.moneyCodes = { ...savedCodes, enabled: true };
  vi.stubGlobal("fetch", () => new Promise(() => {}));
});
afterAll(() => {
  for (const k of SWITCHES) (flags as Record<string, unknown>)[k] = saved[k];
  flags.factoring.enabled = savedFactoring;
  flags.moneyCodes = { ...savedCodes };
  vi.unstubAllGlobals();
});
beforeEach(() => {
  state.fx = defaults();
  state.session = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// The Cash page and Home's Friday card read the carrier's today; these variants pin it (only Date is
// faked) so each takes the path it names whatever day the test runs.
const onDay = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });

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

// shows: words the variant must render (one string or several), so it is known to have taken the
// path it names and the state it names is the one the scan read.
type Variant = { name: string; setup?: () => void; load: () => Promise<ReactNode>; shows?: string | string[] };
// failureScreen: the route file is itself a failure screen (not found), so it must show its title.
type PageCase = { file: string; variants: Variant[]; allow?: ReadonlySet<string>; failureScreen?: boolean };

// A loading screen: what a person sees while the page's reads run.
const loading = (file: string, load: () => Promise<{ default: () => ReactNode }>): PageCase => ({
  file,
  variants: [{ name: "loading", load: async () => (await load()).default() }],
});

// The advance record page in each state a person meets: waiting, paid, rejected, taken back,
// recorded by the office before the app, refused by today's pay rules, and unreadable rules.
const RECORD = fx.ADVANCE_RECORD;
const EVERY_REFUSAL = [
  "driver_inactive",
  "driver_not_armed",
  "below_minimum",
  "no_unpaid_earnings",
  "exceeds_earned_share",
  "over_driver_limit",
  "possible_duplicate",
  "over_load_cap",
] as const;
const ADVANCE_RECORD_CASES: [string, typeof RECORD, string][] = [
  ["approved, payout not confirmed", RECORD, "Advance for Rosa Delgado, Oct 28, 2026"],
  ["allowed by today's pay rules", RECORD, "Yes, it would be allowed today."],
  [
    "waiting for a person",
    {
      ...RECORD,
      advance: { ...RECORD.advance, status: "requested", decidedAt: null, decidedByMembershipId: null },
      proposal: RECORD.proposal && { ...RECORD.proposal, status: "proposed", decidedAt: null },
      ledger: [],
    },
    "Not yet",
  ],
  [
    "paid",
    {
      ...RECORD,
      advance: { ...RECORD.advance, status: "paid", paidAt: "2026-10-28T14:31:00.000Z", recoveredCents: 5_000 },
      proposal: RECORD.proposal && { ...RECORD.proposal, status: "done" },
      ledger: [{ ...RECORD.ledger[0], state: "confirmed", failureCategory: null, settledAt: "2026-10-28T14:31:00.000Z" }],
    },
    "Repaid from pay so far",
  ],
  [
    "rejected",
    {
      ...RECORD,
      advance: { ...RECORD.advance, status: "rejected" },
      proposal: RECORD.proposal && { ...RECORD.proposal, status: "rejected", decisionNote: "Driver already has an advance open." },
      card: null,
      ledger: [],
    },
    "Rejected",
  ],
  [
    "taken back",
    {
      ...RECORD,
      advance: { ...RECORD.advance, status: "cancelled", takenBackCents: 0, takenBackAt: "2026-10-28T15:00:00.000Z", takebackReason: "wrong_driver" },
      takeback: { cents: 0, at: "2026-10-28T15:00:00.000Z", reason: "wrong_driver" },
    },
    "Canceled before payout",
  ],
  [
    "recorded by the office before the app",
    {
      ...RECORD,
      advance: {
        ...RECORD.advance,
        proposalId: null,
        source: "seed",
        status: "paid",
        sourceInputId: null,
        decidedAt: null,
        decidedByMembershipId: null,
        paidAt: null,
        loadId: null,
      },
      proposal: null,
      ledger: [],
      input: null,
      actions: { retry: false, check: false, post: false, takeBack: false },
      load: null,
      headroom: null,
      siblingsOnLoad: [],
    },
    "Recorded by the office before this app",
  ],
  [
    "refused by today's pay rules",
    {
      ...RECORD,
      eligibility: RECORD.eligibility && { ...RECORD.eligibility, eligible: false, maxCents: 0, reasons: [...EVERY_REFUSAL] },
    },
    "No, it would not be allowed today.",
  ],
  ["pay rules unreadable", { ...RECORD, eligibility: null }, "The pay rules could not be checked right now."],
  [
    "agent's check not given, flagged message",
    { ...RECORD, proposal: RECORD.proposal && { ...RECORD.proposal, operatorVerdict: "not_given", flagged: true } },
    "Not given",
  ],
];

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
// An unknown card with no match card, once per reason a person picks the driver.
const HAND_PICK_CASES: [string, HandPick][] = [
  ["by hand: tied", fx.CARD_HAND_PICK],
  ["by hand: no driver fits", { why: "none_fit", candidates: [] }],
  ["by hand: budget spent", { why: "budget", candidates: fx.CARD_HAND_PICK.candidates.slice(0, 1) }],
  ["by hand: no pick", { why: "not_picked", candidates: fx.CARD_HAND_PICK.candidates.slice(1) }],
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
    })).concat(
      HAND_PICK_CASES.map(([name, pick]) => ({
        name,
        setup: cardsOn({ cardBreak: { ...fx.CARD_BREAKS[1], fixKind: "by_hand" }, invoiceProposals: [], cardHandPick: pick }),
        load: async () => (await import("@/app/cards/[breakId]/page")).default({ params: p({ breakId: ID }) }),
        shows: HAND_PICK_WORDS[pick.why],
      })),
    ),
  },
  {
    file: "page.tsx",
    variants: [
      {
        name: "home",
        load: async () => (await import("@/app/page")).default(sp()),
        shows: [
          "Needs you",
          "card in your chat waiting for approval",
          "paystubs waiting for approval",
          "advance request waiting for a decision",
          "invoice waiting for approval",
          "invoices past due",
          "Open driver notes",
          "3 documents, 1 voice note and 2 driver messages today.",
          "Net pay on",
          "Customer payments in",
          "On 3 open invoices",
        ],
      },
      {
        name: "home, nothing waiting",
        setup: () => {
          state.fx.turns = [];
          state.fx.advances = [];
          state.fx.invoices = [];
          state.fx.invoiceProposals = [];
          state.fx.settlementsView = { ...fx.SETTLEMENTS_VIEW, rows: [] };
        },
        load: async () => (await import("@/app/page")).default(sp()),
        shows: ["Nothing is waiting on you. Ask a question or open a page from the menu.", "No paystubs built for"],
      },
      {
        name: "home, a quiet start",
        setup: () => {
          state.fx.todayIntake = { documents: 0, voiceNotes: 0, messages: 0 };
          state.fx.moneyFlow = [];
          state.fx.invoices = [];
          state.fx.settlementsView = { ...fx.SETTLEMENTS_VIEW, period: null, rows: [] };
          state.fx.sweepHome = { openPeriod: null, runs: [] };
        },
        load: async () => (await import("@/app/page")).default(sp()),
        shows: [
          "Nothing yet today.",
          "No sweep of the books has run yet.",
          "No pay week is open yet. Paystubs show here once one is.",
          "No pay weeks yet. Money in and out shows here week by week.",
          "No customer owes you money right now.",
        ],
      },
      {
        name: "home, cards not read",
        // Thenables that reject only when the page awaits them, as failed reads do.
        setup: () => {
          const failed = { then: (_ok: unknown, fail: (e: unknown) => void) => fail(new DbError("unknown")) };
          state.fx.todayIntake = failed;
          state.fx.moneyFlow = failed;
          state.fx.invoices = failed;
          state.fx.settlementsView = failed;
          state.fx.sweepHome = failed;
          state.fx.cashHome = failed;
        },
        load: async () => (await import("@/app/page")).default(sp()),
        shows: [
          "Could not read what came in today.",
          "Could not read the last sweep.",
          "Could not read this pay week's paystubs.",
          "Could not read money in and out.",
          "Could not read what customers owe.",
          "Could not read the last check of Friday's pay run.",
        ],
      },
      {
        name: "home, waiting list not read",
        // A thenable that rejects only when the page awaits it, as a failed read does.
        setup: () => (state.fx.advances = { then: (_ok: unknown, fail: (e: unknown) => void) => fail(new DbError("unknown")) }),
        load: async () => (await import("@/app/page")).default(sp()),
        shows: ["Could not check everything that is waiting right now. Reload the page to try again."],
      },
      {
        name: "asked about a paystub",
        setup: () => (state.fx.paystubAsk = fx.PAYSTUB_ASK),
        load: async () => (await import("@/app/page")).default(sp({ paystub: ID })),
      },
      {
        name: "Friday's pay run short",
        setup: () => {
          onDay("2026-11-02T15:00:00.000Z");
          state.fx.cashHome = fx.CASH_HOME;
        },
        load: async () => (await import("@/app/page")).default(sp()),
        shows: "Short by $6,800.00",
      },
      {
        name: "Friday's pay run out of date",
        setup: () => {
          onDay("2026-11-07T15:00:00.000Z");
          state.fx.cashHome = fx.CASH_HOME;
        },
        load: async () => (await import("@/app/page")).default(sp()),
        shows: OUT_OF_DATE,
      },
      {
        name: "asked to change a pay rule",
        load: async () => (await import("@/app/page")).default(sp({ rule: "1" })),
        shows: payWords.composerHelp(fx.NEXT_START),
      },
    ],
  },
  {
    file: "advances/page.tsx",
    variants: [
      { name: "all", load: async () => (await import("@/app/advances/page")).default(sp()), shows: "Paid to" },
      { name: "paid", load: async () => (await import("@/app/advances/page")).default(sp({ status: "paid" })) },
      { name: "not armed", load: async () => (await import("@/app/advances/page")).default(sp({ armed: "no" })) },
      { name: "empty", setup: () => (state.fx.advances = []), load: async () => (await import("@/app/advances/page")).default(sp()), shows: "Advances appear here" },
      {
        name: "empty, paid only",
        setup: () => (state.fx.advances = []),
        load: async () => (await import("@/app/advances/page")).default(sp({ status: "paid" })),
        shows: "advances appear here",
      },
      {
        name: "empty, drivers not armed",
        setup: () => (state.fx.advances = []),
        load: async () => (await import("@/app/advances/page")).default(sp({ armed: "no" })),
        shows: "for drivers not armed appear here",
      },
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
    file: "cash/page.tsx",
    variants: [
      {
        name: "short, explained, with every move",
        setup: () => onDay("2026-11-02T15:00:00.000Z"),
        load: async () => (await import("@/app/cash/page")).default(),
        shows: "Muse Wonder explains",
      },
      {
        name: "covered, the own sentence after a timeout, from an earlier day",
        setup: () => {
          onDay("2026-11-04T15:00:00.000Z");
          state.fx.cashView = {
            ...fx.CASH_VIEW,
            check: {
              ...fx.CASH_CHECK,
              payRunSource: "stored",
              figures: { ...fx.CASH_CHECK.figures, gapCents: 214_000 },
              explanation: null,
              explainCategory: "timeout",
            },
            cards: [],
          };
        },
        load: async () => (await import("@/app/cash/page")).default(),
        shows: "That was before today",
      },
      {
        name: "short, the paragraph dropped for saying a move covers it",
        setup: () => {
          onDay("2026-11-02T15:00:00.000Z");
          state.fx.cashView = { ...fx.CASH_VIEW, check: { ...fx.CASH_CHECK, explanation: null, explainCategory: "overclaim" } };
        },
        load: async () => (await import("@/app/cash/page")).default(),
        shows: "LedgerLine says",
      },
      {
        name: "no open invoices",
        setup: () => (state.fx.cashView = { ...fx.CASH_VIEW, check: { ...fx.CASH_CHECK, lines: [] } }),
        load: async () => (await import("@/app/cash/page")).default(),
        shows: "No open invoices",
      },
      {
        name: "no check yet",
        setup: () => (state.fx.cashView = { check: null, bills: [], cards: [] }),
        load: async () => (await import("@/app/cash/page")).default(),
        shows: "No check yet",
      },
    ],
  },
  {
    file: "collections/page.tsx",
    variants: [
      {
        name: "late invoices and a reminder in every state",
        load: async () => (await import("@/app/collections/page")).default(),
        shows: "and 1 more",
      },
      {
        name: "refused, every reason",
        setup: () =>
          (state.fx.collectionsView = {
            ...fx.COLLECTIONS_VIEW,
            cards: [...Object.keys(REFUSAL_WORDS), null, "unheard_of"].map((refusalCategory, n) =>
              fx.reminderCard(n + 20, { status: "refused", subject: null, body: null, refusalCategory }),
            ),
          }),
        load: async () => (await import("@/app/collections/page")).default(),
        shows: "did not pass its check",
      },
      {
        name: "every late invoice has a reminder",
        setup: () => (state.fx.collectionsView = { ...fx.COLLECTIONS_VIEW, toDraft: [] }),
        load: async () => (await import("@/app/collections/page")).default(),
        shows: "Every late invoice has a reminder",
      },
      {
        name: "models switched off",
        load: async () => {
          flags.aiEnabled = false;
          try {
            return await (await import("@/app/collections/page")).default();
          } finally {
            flags.aiEnabled = true;
          }
        },
        shows: "no reminders can be drafted right now",
      },
      {
        name: "nobody past due",
        setup: () => (state.fx.collectionsView = { ...fx.COLLECTIONS_VIEW, pastDueCount: 0, pastDueCents: 0, waiting: 0, approvedLastWeek: 0, toDraft: [], cards: [] }),
        load: async () => (await import("@/app/collections/page")).default(),
        shows: "Nobody is 30 or more days past due",
      },
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
    variants: [
      ...fx.DOCUMENTS.map((d) => ({
        name: d.readStatus,
        setup: () => (state.fx.document = d),
        load: async () => (await import("@/app/documents/[id]/page")).default({ params: p({ id: d.id }) }),
      })),
      ...fx.MARKUP_DOCUMENTS.map(({ name, view }) => ({
        name: `marked copy ${name}`,
        setup: () => (state.fx.document = view),
        load: async () => (await import("@/app/documents/[id]/page")).default({ params: p({ id: view.id }) }),
      })),
    ],
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
      {
        name: "driver view with a checked pay card",
        setup: () => (state.fx.driverCard = fx.DRIVER_CARD),
        load: async () =>
          (await import("@/app/driver-notes/[settlementId]/view/page")).default({
            params: p({ settlementId: fx.DRIVER_VIEW.source.settlement.id }),
          }),
        shows: ["Pay card", "Save image"],
      },
    ],
  },
  {
    file: "factoring/page.tsx",
    variants: [
      { name: "requests", load: async () => (await import("@/app/factoring/page")).default(), shows: "Partly funded" },
      {
        name: "none yet",
        setup: () => (state.fx.factoringRequests = []),
        load: async () => (await import("@/app/factoring/page")).default(),
        shows: "No invoices factored yet",
      },
    ],
  },
  {
    file: "factoring/[id]/page.tsx",
    variants: [
      {
        name: "partly funded, one invoice not confirmed yet",
        load: async () => (await import("@/app/factoring/[id]/page")).default({ params: p({ id: ID }) }),
        shows: "Check pending",
      },
      {
        name: "funded",
        setup: () =>
          (state.fx.factoringRequest = {
            ...fx.FACTORING_REQUEST,
            status: "funded",
            cameInCents: fx.FACTORING_REQUEST.lines.reduce((t, l) => t + l.netCents, 0),
            lines: fx.FACTORING_REQUEST.lines.map((l) => ({ ...l, status: "funded" })),
          }),
        load: async () => (await import("@/app/factoring/[id]/page")).default({ params: p({ id: ID }) }),
        shows: "Funded",
      },
    ],
  },
  {
    file: "pay/[periodId]/notes/page.tsx",
    variants: [
      {
        name: "notes",
        load: async () => (await import("@/app/pay/[periodId]/notes/page")).default({ params: p({ periodId: fx.PERIODS[0].id }) }),
        shows: "Pay cards",
      },
    ],
  },
  {
    file: "pay/[periodId]/cards/page.tsx",
    variants: [
      {
        name: "a card in every state",
        load: async () => (await import("@/app/pay/[periodId]/cards/page")).default({ params: p({ periodId: fx.PERIODS[0].id }) }),
        shows: [
          "Pay cards for the week of",
          "Make 6 pay cards",
          "Checked",
          "Save image",
          "Not made yet",
          "Did not match, not saved",
          "Could not check",
          "Waiting for budget",
          "Out of date, make it again",
          "Checking now",
          "All three tries are used for this paystub.",
        ],
      },
      {
        name: "no approved paystub yet",
        setup: () => (state.fx.periodCards = { ...fx.PERIOD_CARDS, rows: [] }),
        load: async () => (await import("@/app/pay/[periodId]/cards/page")).default({ params: p({ periodId: fx.PERIODS[0].id }) }),
        shows: ["Pay cards appear here once the week is approved", "Approve the pay run first."],
      },
      {
        name: "every card checked",
        setup: () =>
          (state.fx.periodCards = { ...fx.PERIOD_CARDS, rows: fx.PERIOD_CARDS.rows.filter((r) => r.pill === "checked") }),
        load: async () => (await import("@/app/pay/[periodId]/cards/page")).default({ params: p({ periodId: fx.PERIODS[0].id }) }),
        shows: ["1 of 1 card checked", "Every card that can be made is made."],
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
    file: "memory/page.tsx",
    variants: [
      {
        name: "notes and a suggestion",
        load: async () => (await import("@/app/memory/page")).default(),
        shows: "The agent suggested 1 note",
      },
      {
        name: "empty",
        setup: () => (state.fx.memoryNotes = []),
        load: async () => (await import("@/app/memory/page")).default(),
        shows: "No notes yet",
      },
    ],
  },
  {
    file: "models/page.tsx",
    variants: [
      { name: "models", load: async () => (await import("@/app/models/page")).default() },
      {
        name: "models with the eval card",
        load: async () => {
          flags.evalCardEnabled = true;
          try {
            return await (await import("@/app/models/page")).default();
          } finally {
            flags.evalCardEnabled = false;
          }
        },
        shows: ["How the models score", "Right amount", "When the operator and the second check agreed"],
      },
    ],
  },
  {
    file: "money-codes/page.tsx",
    variants: [
      { name: "codes", load: async () => (await import("@/app/money-codes/page")).default() },
      {
        name: "with a request waiting",
        setup: () => (state.fx.invoiceProposals = fx.CODE_PROPOSALS),
        load: async () => (await import("@/app/money-codes/page")).default(),
      },
      { name: "empty", setup: () => (state.fx.moneyCodes = []), load: async () => (await import("@/app/money-codes/page")).default() },
    ],
  },
  {
    file: "money-codes/[id]/page.tsx",
    variants: [
      { name: "issued", load: async () => (await import("@/app/money-codes/[id]/page")).default({ params: p({ id: ID }) }) },
      {
        name: "expired",
        setup: () => (state.fx.moneyCode = { ...fx.MONEY_CODE_DETAIL, code: fx.MONEY_CODES[4] }),
        load: async () => (await import("@/app/money-codes/[id]/page")).default({ params: p({ id: ID }) }),
      },
      {
        name: "not confirmed",
        setup: () => (state.fx.moneyCode = fx.MONEY_CODE_UNKNOWN),
        load: async () => (await import("@/app/money-codes/[id]/page")).default({ params: p({ id: ID }) }),
      },
      {
        name: "declined",
        setup: () => (state.fx.moneyCode = fx.MONEY_CODE_FAILED),
        load: async () => (await import("@/app/money-codes/[id]/page")).default({ params: p({ id: ID }) }),
      },
    ],
  },
  {
    file: "money-codes/new/page.tsx",
    variants: [
      { name: "form", load: async () => (await import("@/app/money-codes/new/page")).default() },
      {
        name: "nothing to pick",
        setup: () => (state.fx.codeChoices = { loads: [], receipts: [] }),
        load: async () => (await import("@/app/money-codes/new/page")).default(),
      },
    ],
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
    variants: [
      { name: "run", load: async () => (await import("@/app/portal-runs/[id]/page")).default({ params: p({ id: ID }) }) },
      {
        name: "put back in the queue after a stop",
        setup: () =>
          (state.fx.runView = {
            ...fx.RUN_VIEW,
            run: { ...fx.RUN_VIEW.run, status: "running", endedReason: null, finishedAt: null, resumeAttempts: 2, resumed: "Resumed after a stop (attempt 2 of 2)" },
            evidence: null,
          }),
        load: async () => (await import("@/app/portal-runs/[id]/page")).default({ params: p({ id: ID }) }),
        shows: ["Resumed", "Resumed after a stop (attempt 2 of 2)."],
      },
    ],
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
    file: "profit/page.tsx",
    variants: [
      { name: "no brief yet", load: async () => (await import("@/app/profit/page")).default(sp()), shows: "No brief for this week yet" },
      {
        name: "being written",
        setup: () => (state.fx.profitView = fx.profitView({ kind: "writing" })),
        load: async () => (await import("@/app/profit/page")).default(sp()),
        shows: "The brief is being written",
      },
      {
        name: "written",
        setup: () => (state.fx.profitView = fx.profitView({ kind: "drafted", brief: fx.PROFIT_BRIEF, changed: false })),
        load: async () => (await import("@/app/profit/page")).default(sp()),
        shows: "checked against them.",
      },
      {
        name: "written, figures changed since",
        setup: () => (state.fx.profitView = fx.profitView({ kind: "drafted", brief: fx.PROFIT_BRIEF, changed: true })),
        load: async () => (await import("@/app/profit/page")).default(sp()),
        shows: "changed after this brief was written on",
      },
      {
        name: "did not pass its number check",
        setup: () => (state.fx.profitView = fx.profitView({ kind: "refused", category: "number_mismatch" })),
        load: async () => (await import("@/app/profit/page")).default(sp()),
        shows: "Write the brief again",
      },
      {
        name: "cut off while being written",
        setup: () => (state.fx.profitView = fx.profitView({ kind: "refused", category: "interrupted" })),
        load: async () => (await import("@/app/profit/page")).default(sp()),
        shows: "took too long",
      },
      {
        name: "no priced load that week",
        setup: () =>
          (state.fx.profitView = fx.profitView(
            { kind: "none" },
            {
              profit: {
                ...fx.PROFIT_WEEK,
                totals: { ...fx.PROFIT_WEEK.totals, loads: 0, revenueCents: 0, driverPayCents: 0, marginCents: 0, marginBps: null },
                routes: [],
                customers: [],
                figures: [],
              },
            },
          )),
        load: async () => (await import("@/app/profit/page")).default(sp()),
        shows: "nothing to write about",
      },
      {
        name: "no closed week yet",
        setup: () => (state.fx.profitView = fx.profitView({ kind: "none" }, { weeks: [], week: null, profit: null })),
        load: async () => (await import("@/app/profit/page")).default(sp()),
        shows: "The first brief appears",
      },
    ],
  },
  {
    file: "quarter/page.tsx",
    variants: [
      { name: "no review yet", load: async () => (await import("@/app/quarter/page")).default(), shows: "No review yet" },
      {
        name: "being written",
        setup: () => (state.fx.quarterView = fx.quarterView({ kind: "writing" })),
        load: async () => (await import("@/app/quarter/page")).default(),
        shows: "The review is being written",
      },
      {
        name: "written",
        setup: () => (state.fx.quarterView = fx.quarterView({ kind: "drafted", review: fx.QUARTER_REVIEW, changed: false })),
        load: async () => (await import("@/app/quarter/page")).default(),
        shows: "checked against them.",
      },
      {
        name: "written, figures changed since",
        setup: () => (state.fx.quarterView = fx.quarterView({ kind: "drafted", review: fx.QUARTER_REVIEW, changed: true })),
        load: async () => (await import("@/app/quarter/page")).default(),
        shows: "changed after this review was written on",
      },
      {
        name: "did not pass its number check",
        setup: () => (state.fx.quarterView = fx.quarterView({ kind: "refused", category: "number_mismatch" })),
        load: async () => (await import("@/app/quarter/page")).default(),
        shows: "Write the quarter review again",
      },
      {
        name: "timed out",
        setup: () => (state.fx.quarterView = fx.quarterView({ kind: "refused", category: "timeout" })),
        load: async () => (await import("@/app/quarter/page")).default(),
        shows: "The review did not finish",
      },
      {
        name: "written, but no longer reads back",
        setup: () => (state.fx.quarterView = fx.quarterView({ kind: "unreadable" })),
        load: async () => (await import("@/app/quarter/page")).default(),
        shows: "could not be read back",
      },
      {
        name: "nothing happened yet this quarter",
        setup: () => (state.fx.quarterView = fx.quarterView({ kind: "none" }, { quarter: fx.QUARTER_EMPTY, packed: [] })),
        load: async () => (await import("@/app/quarter/page")).default(),
        shows: "appear after its first pay run or invoice",
      },
    ],
  },
  {
    file: "records/advances/[id]/page.tsx",
    variants: ADVANCE_RECORD_CASES.map(([name, record, shows]) => ({
      name,
      setup: () => (state.fx.advanceRecord = record),
      load: async () => (await import("@/app/records/advances/[id]/page")).default({ params: p({ id: ID }) }),
      shows,
    })),
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
      {
        name: "factored",
        setup: () => (state.fx.factoredLine = fx.FACTORED_LINE),
        load: async () => (await import("@/app/records/invoices/[id]/page")).default({ params: p({ id: ID }) }),
        shows: "Factored (Test mode)",
      },
      {
        name: "sent to factoring, not confirmed yet",
        setup: () => (state.fx.factoredLine = { ...fx.FACTORED_LINE, status: "unknown" }),
        load: async () => (await import("@/app/records/invoices/[id]/page")).default({ params: p({ id: ID }) }),
        shows: "Sent, not confirmed yet (Test mode)",
      },
    ],
  },
  {
    file: "records/loads/[id]/page.tsx",
    variants: [{ name: "record", load: async () => (await import("@/app/records/loads/[id]/page")).default({ params: p({ id: ID }) }) }],
  },
  {
    file: "records/pay_items/[id]/page.tsx",
    variants: fx.PAY_ITEM_CASES.map(([name, view]) => ({
      name,
      setup: () => (state.fx.payItemView = view),
      load: async () => (await import("@/app/records/pay_items/[id]/page")).default({ params: p({ id: ID }) }),
    })),
  },
  {
    file: "records/driver_days/[id]/page.tsx",
    variants: fx.DRIVER_DAY_CASES.map(([name, view, shows]) => ({
      name,
      shows,
      setup: () => (state.fx.driverDayView = view),
      load: async () => (await import("@/app/records/driver_days/[id]/page")).default({ params: p({ id: ID }) }),
    })),
  },
  {
    file: "records/deduction_schedules/[id]/page.tsx",
    variants: fx.SCHEDULE_CASES.map(([name, view]) => ({
      name,
      setup: () => (state.fx.scheduleView = view),
      load: async () => (await import("@/app/records/deduction_schedules/[id]/page")).default({ params: p({ id: ID }) }),
    })),
  },
  // An extra charge this carrier has sends the reader on to its load (checked below); one it does
  // not have is the only screen this route shows.
  {
    file: "records/load_accessorials/[id]/page.tsx",
    failureScreen: true,
    variants: [
      {
        name: "an extra charge this carrier does not have",
        load: async () => (await import("@/app/records/load_accessorials/[id]/page")).default({ params: p({ id: ID }) }),
        shows: "Extra charge",
      },
    ],
  },
  {
    file: "records/vendor_bills/[id]/page.tsx",
    variants: fx.VENDOR_BILLS.map((b) => ({
      name: `${b.status}, ${b.urgency}`,
      setup: () => (state.fx.vendorBill = b),
      load: async () => (await import("@/app/records/vendor_bills/[id]/page")).default({ params: p({ id: b.id }) }),
      shows: b.billRef,
    })),
  },
  {
    file: "drivers/page.tsx",
    variants: [
      {
        name: "active drivers",
        setup: () => onDay("2026-11-02T15:00:00.000Z"),
        load: async () => (await import("@/app/drivers/page")).default(sp()),
        shows: ["Rosa Delgado", "No card", "top net Rosa Delgado (BR-D07) $2,225.00"],
      },
      {
        name: "departed, by owed, last 90 days",
        setup: () => onDay("2026-11-02T15:00:00.000Z"),
        load: async () => (await import("@/app/drivers/page")).default(sp({ status: "departed", sort: "owed", days: "90" })),
        shows: ["Lena Ortiz", "Departed", "Last 90 days"],
      },
      {
        name: "search with no match",
        setup: () => onDay("2026-11-02T15:00:00.000Z"),
        load: async () => (await import("@/app/drivers/page")).default(sp({ q: "nobody" })),
        shows: "No driver matches that search",
      },
      {
        name: "no drivers yet",
        setup: () => {
          onDay("2026-11-02T15:00:00.000Z");
          state.fx.driverInsightInput = { ...fx.DRIVER_INSIGHT_INPUT, drivers: [], periods: [], settlements: [], lines: [], loads: [], advances: [], deficits: [] };
        },
        load: async () => (await import("@/app/drivers/page")).default(sp()),
        shows: "no paid paystubs, deliveries or amounts owed yet",
      },
    ],
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
    file: "settings/pay-rules/page.tsx",
    variants: [
      {
        name: "rules and changes waiting",
        load: async () => (await import("@/app/settings/pay-rules/page")).default(),
        shows: payWords.NOTHING_CHANGES,
      },
      {
        name: "nothing waiting",
        setup: () => (state.fx.ruleChanges = []),
        load: async () => (await import("@/app/settings/pay-rules/page")).default(),
        shows: payWords.WAITING_EMPTY_TITLE,
      },
      {
        name: "staff, a change over the admin amount",
        setup: () => (state.fx.payRulesPage = { ...fx.PAY_RULES_PAGE, role: "staff" }),
        load: async () => (await import("@/app/settings/pay-rules/page")).default(),
        shows: payWords.adminOnlyLabel(flags.approverRole.adminAboveCents),
      },
      {
        name: "rules could not be read",
        setup: () => (state.fx.payRulesPage = new Error("unreadable")),
        load: async () => (await import("@/app/settings/pay-rules/page")).default(),
        shows: payWords.LOAD_FAILED_TITLE,
      },
    ],
  },
  {
    file: "sign-in/page.tsx",
    variants: [
      { name: "form", load: async () => (await import("@/app/sign-in/page")).default({ searchParams: p({}) }) },
      { name: "invalid", load: async () => (await import("@/app/sign-in/page")).default({ searchParams: p({ error: "invalid" }) }) },
      { name: "unavailable", load: async () => (await import("@/app/sign-in/page")).default({ searchParams: p({ error: "unavailable" }) }) },
      {
        name: "demo carrier card",
        load: async () => {
          flags.judgeAccess.enabled = true;
          try {
            return await (await import("@/app/sign-in/page")).default({ searchParams: p({}) });
          } finally {
            flags.judgeAccess.enabled = false;
          }
        },
        shows: ["Try the demo carrier", "Nothing is paid or sent.", "The data is made up, so please do not upload real documents."],
      },
      {
        name: "demo sign-in unavailable",
        load: async () => (await import("@/app/sign-in/page")).default({ searchParams: p({ demo: "unavailable" }) }),
        shows: "The demo sign-in is not available right now. The video shows the full flow.",
      },
      {
        name: "demo visit ended",
        load: async () => {
          flags.judgeAccess.enabled = true;
          try {
            return await (await import("@/app/sign-in/page")).default({ searchParams: p({ demo: "expired" }) });
          } finally {
            flags.judgeAccess.enabled = false;
          }
        },
        shows: ["Your demo visit ended. Start another any time.", "Try the demo carrier"],
      },
    ],
  },
  {
    file: "help/how-pay-works/page.tsx",
    variants: [
      {
        name: "signed out",
        load: async () => (await import("@/app/help/how-pay-works/page")).default(),
        shows: "Sign in to try the demo",
      },
      {
        name: "signed in, her paystub drafted",
        setup: () => (state.session = SESSION),
        load: async () => (await import("@/app/help/how-pay-works/page")).default(),
        shows: "See her paystub",
      },
      {
        name: "signed in, the week not run yet",
        setup: () => {
          state.session = SESSION;
          state.fx.heroLink = fx.HERO_LINK_DRIVER;
        },
        load: async () => (await import("@/app/help/how-pay-works/page")).default(),
        shows: "run the week on Settlements",
      },
      {
        name: "signed in, a carrier without her",
        setup: () => {
          state.session = SESSION;
          state.fx.heroLink = null;
        },
        load: async () => (await import("@/app/help/how-pay-works/page")).default(),
        shows: fx.TENANT.name,
      },
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
            run: { ...fx.SWEEP_RUN, checklist: endSweep(tickSweep(sweepChecklist(true), "draft"), "done") },
            fanout: { ...fx.SWEEP_FANOUT, status: "skipped_daily_cap", checks: [], reconcile: { counts: null, summary: null, disagreements: [], turnId: null } },
          }),
        load: async () => (await import("@/app/sweep/[id]/page")).default({ params: p({ id: ID }) }),
      },
      {
        name: "stopped by its budget, its checklist not finished",
        setup: () => (state.fx.sweepPage = { ...fx.SWEEP_PAGE, run: fx.SWEEP_RUN_STOPPED }),
        load: async () => (await import("@/app/sweep/[id]/page")).default({ params: p({ id: ID }) }),
      },
      {
        name: "stopped at its turn ceiling, the rest left for the next sweep",
        setup: () =>
          (state.fx.sweepPage = { ...fx.SWEEP_PAGE, run: fx.SWEEP_RUN_MAX_TURNS, counts: { ...fx.SWEEP_PAGE.counts, left: 5 } }),
        load: async () => (await import("@/app/sweep/[id]/page")).default({ params: p({ id: ID }) }),
        shows: "Stopped after 30 turns: 2 fixes drafted, 1 needs a person, 5 left for the next sweep. Nothing was paid.",
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
    file: "settings/rates/page.tsx",
    variants: [
      {
        name: "pinned, with a newer lookup and a state not matched",
        load: async () => (await import("@/app/settings/rates/page")).default(),
        shows: RATES_WORDS.notMatched,
      },
      {
        name: "nothing pinned yet",
        setup: () => (state.fx.ratesPage = fx.RATES_EMPTY),
        load: async () => (await import("@/app/settings/rates/page")).default(),
        shows: RATES_WORDS.emptyTitle,
      },
      {
        name: "a staff member, who cannot pin",
        setup: () => (state.fx.ratesPage = { ...fx.RATES_PAGE, canPin: false, lookupsLeft: 0 }),
        load: async () => (await import("@/app/settings/rates/page")).default(),
        shows: RATES_WORDS.onlyAdmin,
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
  loading("cash/loading.tsx", () => import("@/app/cash/loading")),
  loading("collections/loading.tsx", () => import("@/app/collections/loading")),
  loading("documents/loading.tsx", () => import("@/app/documents/loading")),
  loading("documents/[id]/loading.tsx", () => import("@/app/documents/[id]/loading")),
  loading("driver-notes/loading.tsx", () => import("@/app/driver-notes/loading")),
  loading("driver-notes/[settlementId]/view/loading.tsx", () => import("@/app/driver-notes/[settlementId]/view/loading")),
  loading("invoices/loading.tsx", () => import("@/app/invoices/loading")),
  loading("memory/loading.tsx", () => import("@/app/memory/loading")),
  loading("models/loading.tsx", () => import("@/app/models/loading")),
  loading("pay/[periodId]/notes/loading.tsx", () => import("@/app/pay/[periodId]/notes/loading")),
  loading("pay/[periodId]/cards/loading.tsx", () => import("@/app/pay/[periodId]/cards/loading")),
  loading("profit/loading.tsx", () => import("@/app/profit/loading")),
  loading("quarter/loading.tsx", () => import("@/app/quarter/loading")),
  loading("records/loading.tsx", () => import("@/app/records/loading")),
  loading("settings/pay-rules/loading.tsx", () => import("@/app/settings/pay-rules/loading")),
  loading("sweep/loading.tsx", () => import("@/app/sweep/loading")),
  loading("sweep/fuel/loading.tsx", () => import("@/app/sweep/fuel/loading")),
  loading("settings/rates/loading.tsx", () => import("@/app/settings/rates/loading")),
];

// Route files this test does not render as a page, each with the reason. Keep it short: a new page
// belongs above.
const LISTED: Readonly<Record<string, string>> = {
  "layout.tsx":
    "The document around every page: it puts each one in the html shell and the toast holder and shows no words on the page. Its tab title and description are scanned below.",
  "records/settlement_periods/[id]/page.tsx":
    "Shows nothing of its own: it only sends a pay week's link on to that week on the Settlements page, which is rendered above.",
  "help/page.tsx":
    "Shows nothing of its own: it only sends the bare help address on to How trucking pay works, which is rendered above.",
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
  // Home opens the agent card as it loads when asked (a paystub, a pay rule change), so its words
  // are read too: jsdom has no dialog methods, and the card's read of the newest conversation
  // answers with none. Every other request still never answers.
  beforeEach(() => {
    HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    vi.stubGlobal("fetch", (url: string) =>
      url === "/api/agent/recent"
        ? Promise.resolve(new Response(JSON.stringify({ conversationId: null, turns: [] }), { status: 200 }))
        : new Promise(() => {}),
    );
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    vi.stubGlobal("fetch", () => new Promise(() => {}));
  });

  for (const c of PAGES) {
    for (const v of c.variants) {
      it(`${c.file} (${v.name})`, async () => {
        v.setup?.();
        const container = await renderPage(v.load);
        const card = container.querySelector("dialog[open]");
        if (card) await waitFor(() => expect(card.querySelector("textarea[data-composer]")).not.toBeNull());
        const text = container.textContent ?? "";
        expect(text.trim().length).toBeGreaterThan(0);
        for (const words of [v.shows ?? []].flat()) expect(text, "the state this variant names").toContain(words);
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

// A page switched off for the carrier shows only the shell and the off note. The page variants above
// must never land there, so the off state is read here, with its own switch put back after.
describe("no internal word on a switched-off page", () => {
  it("collections/page.tsx (switch off)", async () => {
    flags.collectionsEnabled = false;
    try {
      const container = await renderPage(async () => (await import("@/app/collections/page")).default());
      expect(container.textContent).toContain("Collections is off for this carrier");
      expect(scan(container)).toEqual([]);
    } finally {
      flags.collectionsEnabled = true;
    }
  });
});

// The record pages a paystub line links to, for a record this carrier does not have: each shows the
// not-here screen under its own plain title. A page case scans one file once, so these sit here.
describe("the paystub line record pages, for a record that is not here", () => {
  const MISSING: [string, string, () => Promise<{ default: (a: { params: Promise<{ id: string }> }) => Promise<ReactNode> }>][] = [
    ["payItemView", "Pay item", () => import("@/app/records/pay_items/[id]/page")],
    ["driverDayView", "Day driven", () => import("@/app/records/driver_days/[id]/page")],
    ["scheduleView", "Weekly deduction", () => import("@/app/records/deduction_schedules/[id]/page")],
  ];
  let failures: string[] = [];
  beforeAll(() => {
    failures = failureTitles();
  });

  for (const [key, title, mod] of MISSING) {
    it(`${title}`, async () => {
      state.fx[key] = null;
      const container = await renderPage(async () => (await mod()).default({ params: p({ id: ID }) }));
      const text = container.textContent ?? "";
      expect(text).toContain(title);
      expect(failures.some((t) => text.includes(t)), "the not-here screen shows its title").toBe(true);
      expect(scan(container)).toEqual([]);
    });
  }

  it("an extra charge this carrier has sends the reader to its load's Extra charges table", async () => {
    state.fx.extraChargeLoadId = fx.LOAD_RECORD.id;
    const { default: page } = await import("@/app/records/load_accessorials/[id]/page");
    await expect(page({ params: p({ id: ID }) })).rejects.toThrow(`redirect /records/loads/${fx.LOAD_RECORD.id}#extra-charges`);
  });

  it("the help page's tab title and description", async () => {
    const { metadata } = await import("@/app/help/how-pay-works/page");
    expect(hitsIn(`${String(metadata.title)}\n${String(metadata.description)}`, new Set())).toEqual([]);
  });
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
    it(`${name} card seen by a demo visitor, every status and second-check state`, async () => {
      for (const status of STATUSES) {
        for (const audit of AUDITS) {
          for (const confirming of [false, true]) {
            const { container, unmount } = render(
              <ViewerRoleProvider role="judge">
                <ProposalCard {...sample} status={status} audit={audit} onApprove={() => {}} onReject={() => {}} canResume initialConfirming={confirming} />
              </ViewerRoleProvider>,
            );
            expect(scan(container)).toEqual([]);
            unmount();
          }
        }
      }
    });
  }
});

// The Verified / Unverified label in each state it can show, on a waiting and a decided card.
const VERIFICATIONS: ProposalVerification[] = [
  { state: "verified", line: VERIFY_LINES.verified, held: false },
  ...Object.values(VERIFY_LINES).map((line) => ({ state: "unverified" as const, line, held: false })),
  { state: "mismatch", line: VERIFY_LINES.held, held: true },
  { state: "mismatch", line: VERIFY_LINES.mismatch, held: false },
  {
    state: "mismatch",
    line: VERIFY_LINES.mismatch,
    held: false,
    override: { reason: "The rate sheet changed this week", byLabel: "Admin", at: "Oct 28, 10:00 AM" },
  },
];

describe("no internal word on a card's Verified label", () => {
  for (const status of ["proposed", "approved"] as const) {
    it(`advance card, ${status}, every label state, with and without a block`, () => {
      for (const verification of VERIFICATIONS) {
        for (const audit of [AUDITS[2], AUDITS[4]]) {
          for (const confirming of [false, true]) {
            const { container, unmount } = render(
              <ProposalCard
                {...ADVANCE_PROPOSAL}
                status={status}
                audit={audit}
                verification={verification}
                onApprove={() => {}}
                onReject={() => {}}
                initialConfirming={confirming}
              />,
            );
            expect(scan(container), `${verification.line}${confirming ? ", confirm open" : ""}`).toEqual([]);
            unmount();
          }
        }
      }
    });
  }
});

// Every kind's card as the chat builds it, plus a kind the table has no row for, in every status;
// a waiting card is also read with its approve question open and with its reject question open.
const KIND_VIEWS: [string, ProposalView][] = (() => {
  const base: ProposalView = {
    id: fx.ID,
    kind: "advance_payout",
    subjectTable: "drivers",
    subjectId: fx.ID,
    subjectLabel: "BR-D07",
    amountCents: 20_000,
    direction: "out",
    title: "Pay advance",
    reasons: [{ category: "earned_unpaid_covers", text: "Earned, unpaid pay this week covers the advance.", source: { table: "drivers", id: fx.ID } }],
    sources: [
      { table: "drivers", id: fx.ID },
      { table: "loads", id: "0b9f6a52-3c1d-4e8f-9a7b-000000000004" },
      { table: "loads", id: "0b9f6a52-3c1d-4e8f-9a7b-000000000005" },
    ],
    status: "proposed",
    flagged: false,
    flagCategories: [],
    operatorVerdict: "eligible",
    auditorVerdict: "pass",
    auditorConcerns: [],
    auditorCheckedAt: "2026-10-28T15:00:00.000Z",
    auditorOverride: null,
    destination: null,
  };
  const loads = { subjectTable: "loads", subjectLabel: "BR-L0412" };
  return [
    ["advance, card on file", { ...base, destination: { label: "fuel card", last4: "4417", testMode: true } }],
    ["advance, no card", { ...base, destination: { label: "no fuel card on file", last4: null, testMode: true } }],
    ["advance, flagged", { ...base, flagged: true, flagCategories: ["authority_claim"], destination: { label: "fuel card", last4: "4417", testMode: true } }],
    ["pay correction", { ...base, kind: "pay_correction", title: "Correct pay" }],
    ["load rate", { ...base, ...loads, kind: "load_rate_fill", direction: "none", title: "Fill load rate" }],
    ["invoice", { ...base, ...loads, kind: "invoice_post", direction: "in", title: "Create invoice" }],
    ["payment move", { ...base, subjectTable: "payment_applications", subjectLabel: "CHK-1042", kind: "payment_reapply", direction: "none", title: "Move payment" }],
    ["detention", { ...base, ...loads, kind: "detention_charge", direction: "in", title: "Bill detention" }],
    ["paystub", { ...base, subjectTable: "settlements", kind: "settlement_approve", title: "Approve paystub" }],
    ["paystub, no payout", { ...base, subjectTable: "settlements", kind: "settlement_approve", amountCents: 0, title: "Approve paystub" }],
    ["invoice fix", { ...base, ...loads, kind: "invoice_fix", direction: "none", title: "Fix invoice" }],
    ["a kind with no row yet", { ...base, kind: "money_code" as ProposalView["kind"], title: "Issue money code" }],
    ["no subject code", { ...base, subjectLabel: null }],
    ["advance, pay rules matched", { ...base, engineCheck: "matched", engineHeld: false, engineOverride: null }],
    ["advance, pay rules not checked", { ...base, auditorVerdict: null, engineCheck: null, engineHeld: false, engineOverride: null }],
    ["advance, not recomputed", { ...base, engineCheck: "unavailable", engineHeld: false, engineOverride: null }],
    ["advance, held mismatch", { ...base, engineCheck: "mismatch", engineHeld: true, engineOverride: null }],
    [
      "paystub, approved over a mismatch",
      {
        ...base,
        subjectTable: "settlements",
        kind: "settlement_approve",
        title: "Approve paystub",
        engineCheck: "mismatch",
        engineHeld: false,
        engineOverride: { reason: "The rate sheet changed this week", byLabel: "an admin", at: "2026-10-28T15:00:00.000Z" },
      },
    ],
  ];
})();

describe("no internal word on a card built from each kind", () => {
  for (const [name, view] of KIND_VIEWS) {
    it(name, async () => {
      for (const status of STATUSES) {
        const card = proposalCardFrom({ ...view, status }, { on: true, checking: false, timezone: "America/Chicago" });
        for (const confirming of [false, true]) {
          const { container, unmount } = render(
            <ProposalCard {...card} onApprove={() => {}} onReject={() => {}} initialConfirming={confirming} />,
          );
          expect(scan(container), `${status}${confirming ? ", confirm open" : ""}`).toEqual([]);
          unmount();
        }
        if (status === "proposed") {
          const { container, unmount } = render(<ProposalCard {...card} onApprove={() => {}} onReject={() => {}} />);
          fireEvent.click(screen.getByRole("button", { name: "Reject" }));
          expect(screen.getByRole("group", { name: "Confirm rejection" })).toBeTruthy();
          expect(scan(container), "reject question open").toEqual([]);
          unmount();
        }
      }
    });
  }
});

describe("no internal word on the advance request form", () => {
  const DRIVER_ID = "0b9f6a52-3c1d-4e8f-9a7b-000000000003";
  const REFUSALS = ["disabled", "agent_off", "ai_off", "not_found", "busy", "bad_request", "unauthenticated", "forbidden", "something_new"];

  async function fill() {
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: DRIVER_ID } });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "250" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "fuel" } });
  }

  it("its field errors, and its switched-off look", async () => {
    const { RequestForm } = await import("@/app/advances/new/request-form");
    for (const disabled of [false, true]) {
      const { container, unmount } = render(
        <ToastProvider>
          <RequestForm drivers={[{ id: DRIVER_ID, code: "BR-D07", name: "Rosa Delgado" }]} disabled={disabled} />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Check this request" }));
      expect(scan(container)).toEqual([]);
      unmount();
    }
  });

  it("every refusal sentence, a lost answer, an unfinished check, and the toast after the answer", async () => {
    const { RequestForm } = await import("@/app/advances/new/request-form");
    const done = new Response(JSON.stringify({ ok: true, status: "done" }), { status: 200 });
    const answers: (Response | "lost")[] = [
      ...REFUSALS.map((error) => new Response(JSON.stringify({ error }), { status: 409 })),
      "lost",
      new Response(JSON.stringify({ ok: true, status: "failed" }), { status: 200 }),
      done,
    ];
    for (const answer of answers) {
      vi.stubGlobal("fetch", async (url: string) => {
        if (url !== "/api/advances/request") {
          return new Response(JSON.stringify({ loads: [], suggestion: { armed: true, maxCents: 25_000, suggestedCents: 25_000, feeCents: 0, load: null } }));
        }
        if (answer === "lost") throw new TypeError("network");
        return answer;
      });
      const { container, unmount } = render(
        <ToastProvider>
          <RequestForm drivers={[{ id: DRIVER_ID, code: "BR-D07", name: "Rosa Delgado" }]} disabled={false} />
        </ToastProvider>,
      );
      await fill();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Check this request" }));
      });
      // Each answer shows its words: the toast after a finished check, a sentence on the form otherwise.
      if (answer === done) expect(container.textContent).toContain("The answer appears on Home.");
      else expect(screen.getByRole("alert").textContent?.length).toBeGreaterThan(0);
      expect(scan(container)).toEqual([]);
      unmount();
    }
    vi.stubGlobal("fetch", () => new Promise(() => {}));
  });
});

describe("no internal word on a paystub", () => {
  it("the sample paystubs", () => {
    const underRules = [{ ...PAYSTUB, payRules: { from: "2026-10-19", href: payWords.PAY_RULES_PATH } }, { ...PAYSTUB, payRules: { from: "2026-10-19" } }];
    for (const stub of [PAYSTUB, SHORT_WEEK_PAYSTUB, ...underRules]) {
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
        "Updated the checklist",
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

  it("an answer in paragraphs, bullets and bold, a stopped turn with its card, and repeated steps", () => {
    const thinking = (i: number) => ({ id: `think-${i}`, seq: i, kind: "model" as const, label: "Thinking it through", state: "done" as const });
    const answered: TurnView = {
      ...fx.TURNS[0],
      id: "turn-bullets",
      text: "Three drivers need a look:\n\n* **Rosa Delgado (BR-D07)** is short $250.00\n- Marcus Hale has 1 exception\n\nNothing was paid.",
      steps: [thinking(1), { ...fx.TURNS[0].steps[1], seq: 2 }, thinking(3), thinking(4)],
      proposals: [],
    };
    const stopped: TurnView = {
      ...fx.TURNS[0],
      id: "turn-stopped",
      status: "partial",
      endedReason: "steps",
      text: `${STOPPED_TEXT}\n\nRosa Delgado can take up to $400.00.`,
    };
    const empty: TurnView = { ...stopped, id: "turn-stopped-empty", proposals: [], text: STOPPED_TEXT };
    const messages = toMessages([answered, stopped, empty], {}, {}, undefined, { on: true, checking: {}, timezone: fx.TENANT.timezone });
    const { container } = render(<ChatThread messages={messages} composer={{}} />);
    const text = container.textContent ?? "";
    expect(text).toContain(FOUND_TEXT);
    expect(text).toContain("Rosa Delgado (BR-D07)");
    expect(container.querySelector("strong")).not.toBeNull();
    // The repeated step shows once in the first answer's list.
    const first = screen.getAllByRole("list", { name: "What the agent did" })[0];
    expect(first.textContent?.match(/Thinking it through/g)).toHaveLength(1);
    expect(scan(container)).toEqual([]);
  });

  it("the answer's Verified header in each state, with its reasons", () => {
    const card = { ...fx.PROPOSALS[0], engineCheck: "matched" as const, engineHeld: false, auditorVerdict: "pass" };
    const pending = { ...card, auditorVerdict: null };
    const base: TurnView = { ...fx.TURNS[0], status: "done", error: null, proposals: [card] };
    const turns: TurnView[] = [
      { ...base, id: "turn-verified", withheldFigures: 0 },
      { ...base, id: "turn-plain", withheldFigures: 0, proposals: [] },
      { ...base, id: "turn-withheld", withheldFigures: 2 },
      { ...base, id: "turn-unknown", withheldFigures: null },
      { ...base, id: "turn-cards", withheldFigures: 0, proposals: [card, pending] },
    ];
    const messages = toMessages(turns, {}, {}, undefined, { on: true, checking: {}, timezone: fx.TENANT.timezone });
    const { container } = render(<ChatThread messages={messages} composer={{}} />);
    const text = container.textContent ?? "";
    for (const shown of [ANSWER_PILL.verified, ANSWER_PILL.unverified, ...Object.values(ANSWER_REASONS)]) expect(text).toContain(shown);
    expect(scan(container)).toEqual([]);
  });

  it("a checklist in every state, and an answer stopped at its step budget with its plain summary", () => {
    const messages = toMessages(fx.CHECKLIST_TURNS, {}, {}, undefined, { on: true, checking: {}, timezone: fx.TENANT.timezone });
    const { container } = render(<ChatThread messages={messages} composer={{}} />);
    const lists = screen.getAllByRole("list", { name: "Checklist" });
    expect(lists).toHaveLength(2);
    for (const word of ["to do", "working on it", "done", "skipped", "not finished"]) {
      expect(lists[0].textContent).toContain(`, ${word}`);
    }
    expect(lists[0].textContent).toContain("Skipped");
    expect(lists[0].textContent).toContain("Not finished");
    const text = container.textContent ?? "";
    expect(text).toContain("I stopped after 6 steps. Done: Read Rosa's loads this week. Not done:");
    expect(text).toContain("Nothing was paid or sent.");
    expect(scan(container)).toEqual([]);
  });

  it("a request that went to a person after its refused tries, the checks' words, and its Needs you row", () => {
    const escalated: TurnView = {
      ...fx.TURNS[0],
      id: "turn-escalated",
      status: "partial",
      endedReason: "escalated",
      text: escalatedText(3),
      proposals: [],
      steps: [
        { id: "esc-1", seq: 1, kind: "tool", label: "Checking advance eligibility", state: "failed" },
        { id: "esc-2", seq: 2, kind: "escalation", label: "Escalated to a person", state: "failed" },
      ],
    };
    const fewer = [1, 2].map((n): TurnView => ({ ...escalated, id: `turn-escalated-${n}`, text: escalatedText(n) }));
    const messages = toMessages([escalated, ...fewer], {}, {}, undefined, { on: true, checking: {}, timezone: fx.TENANT.timezone });
    const { container } = render(
      <>
        <ChatThread messages={messages} composer={{}} />
        <NeedsYou view={{ rows: [escalatedRow(2)!], unread: false }} />
        <ul>
          {Object.values(PROPOSAL_CHECK_WORDS).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("I tried three times and could not make a card that passed the checks.");
    expect(text).toContain("I tried twice");
    expect(text).toContain("requests in your chat escalated to a person");
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
    // Open every Details, so the per-step effort and cache lines are read too.
    for (const summary of await screen.findAllByText("Details", { selector: "summary" })) {
      fireEvent.click(summary);
    }
    const body = document.body;
    expect(body.textContent).toMatch(/Muse/);
    expect(screen.getAllByRole("list", { name: "Models used" })).toHaveLength(2);
    expect(screen.getAllByRole("list", { name: "Details for each step" })).toHaveLength(2);
    expect(body.textContent).toMatch(/Asked for (low|high) effort/);
    expect(scan(body)).toEqual([]);
  });

  it("the step-through, on every turn, with the summary's parts and its own text opened", async () => {
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} stepThrough load={async () => ({ trace: { ...sampleTrace(), notesUsed: fx.NOTES_USED } })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /How this was worked out/i }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Step through" }));
    const view = screen.getByRole("region", { name: "Step through" });
    const next = within(view).getByRole("button", { name: "Next" }) as HTMLButtonElement;
    let turns = 0;
    for (;;) {
      turns += 1;
      for (const summary of within(view).queryAllByText("Details", { selector: "summary" })) fireEvent.click(summary);
      expect(scan(document.body)).toEqual([]);
      if (next.disabled) break;
      fireEvent.click(next);
    }
    expect(turns).toBe(4);
    expect(within(view).getByRole("list", { name: "Parts of the summary" })).toBeTruthy();
    // The summary's own text is the model's input word for word (ids, dates, its own section
    // titles), shown as plain text only when a person opens it. Everything around it is scanned.
    fireEvent.click(within(view).getByRole("button", { name: "Show the summary" }));
    const verbatim = view.querySelector("[data-verbatim='summary']");
    expect(verbatim?.textContent).toBe(sampleTrace().contextSummary);
    const rest = document.body.cloneNode(true) as HTMLElement;
    for (const el of Array.from(rest.querySelectorAll("[data-verbatim]"))) el.remove();
    expect(rest.querySelector("[data-verbatim]")).toBeNull();
    expect(scan(rest)).toEqual([]);
  });

  it("the step-through, for an answer whose summary and notes were not kept", async () => {
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} stepThrough load={async () => ({ trace: { ...sampleTrace(), contextSummary: undefined } })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /How this was worked out/i }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Step through" }));
    const view = screen.getByRole("region", { name: "Step through" });
    expect(within(view).getByText(NOTE_NOT_KEPT)).toBeTruthy();
    expect(scan(document.body)).toEqual([]);
  });

  it("the trace's note links, for an answer that read the office's notes", async () => {
    render(<HowWorkedOut turnId={SAMPLE_TURN_ID} load={async () => ({ trace: { ...sampleTrace(), notesUsed: fx.NOTES_USED } })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /How this was worked out/i }));
    });
    const notes = screen.getByRole("list", { name: "Notes it read" });
    const kept = fx.NOTES_USED.filter((n) => n.label !== null);
    expect(within(notes).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(kept.map((n) => `/memory#note-${n.id}`));
    expect(document.body.textContent).toContain("Remembered 3 notes from the office; 1 has since been removed");
    expect(scan(document.body)).toEqual([]);
  });
});

describe("no internal word on the Memory board, in every state", () => {
  const board = (notes = fx.MEMORY_NOTES, maxNotes = 500) =>
    render(
      <ToastProvider>
        <NotesBoard notes={notes} subjects={fx.NOTE_SUBJECTS} timeZone={fx.TENANT.timezone} maxChars={300} maxNotes={maxNotes} />
      </ToastProvider>,
    );
  const click = async (name: string, inside: HTMLElement = document.body) => {
    await act(async () => {
      fireEvent.click(within(inside).getByRole("button", { name }));
    });
  };
  // Every category a save can answer, and a save lost on the way (read as not known).
  const REFUSALS = ["off", "invalid", "subject_not_found", "full", "duplicate", "not_found", "forbidden", "unreadable"] as const;
  type Act = (typeof noteActions)[keyof typeof noteActions];
  // Each refusal, then the lost save, through one action; returns the words each one showed.
  const refuseEach = async (action: Act, save: () => Promise<void>, shown: () => string): Promise<string[]> => {
    const seen: string[] = [];
    for (const category of REFUSALS) {
      action.mockResolvedValueOnce({ ok: false, category });
      await save();
      seen.push(shown());
      expect(scan(document.body), category).toEqual([]);
    }
    action.mockRejectedValueOnce(new Error("lost on the way"));
    await save();
    seen.push(shown());
    expect(scan(document.body), "not known").toEqual([]);
    return seen;
  };

  afterEach(() => {
    for (const f of Object.values(noteActions)) f.mockReset();
  });

  it("full, at the most notes a carrier keeps", () => {
    board(fx.MEMORY_NOTES, fx.MEMORY_NOTES.length);
    expect(screen.getByText("Remove a note first")).toBeTruthy();
    expect(scan(document.body)).toEqual([]);
  });

  it("adding a note: the form, an empty save, each refusal (the duplicate among them) and the done note", async () => {
    board();
    await click("Add a note");
    expect(screen.getByRole("heading", { name: "Add a note" })).toBeTruthy();
    expect(scan(document.body)).toEqual([]);
    await click("Save note");
    expect(screen.getByText("Write the note first.")).toBeTruthy();
    expect(scan(document.body)).toEqual([]);
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Calls ahead on every delivery" } });
    const seen = await refuseEach(noteActions.addNoteAction, () => click("Save note"), () => document.getElementById("note-text-error")?.textContent ?? "");
    expect(new Set(seen).size).toBe(REFUSALS.length + 1);
    expect(seen.every((t) => t.length > 0)).toBe(true);
    noteActions.addNoteAction.mockResolvedValueOnce({ ok: true });
    await click("Save note");
    expect(screen.getByText("Note added")).toBeTruthy();
    expect(scan(document.body)).toEqual([]);
  });

  it("editing a note: the open editor, an empty save, each refusal and the done note", async () => {
    board();
    const target = fx.MEMORY_NOTES[0];
    await click("Edit the note about Tanglewood Grocery Supply");
    const editor = `edit-${target.id}`;
    expect(document.getElementById(editor)).toBeTruthy();
    expect(scan(document.body)).toEqual([]);
    fireEvent.change(document.getElementById(editor)!, { target: { value: " " } });
    await click("Save");
    expect(screen.getByText("Write the note first, or remove it.")).toBeTruthy();
    expect(scan(document.body)).toEqual([]);
    fireEvent.change(document.getElementById(editor)!, { target: { value: "Pays about 30 days after due" } });
    const seen = await refuseEach(noteActions.editNoteAction, () => click("Save"), () => document.getElementById(`${editor}-error`)?.textContent ?? "");
    expect(new Set(seen).size).toBe(REFUSALS.length + 1);
    noteActions.editNoteAction.mockResolvedValueOnce({ ok: true });
    await click("Save");
    expect(screen.getByText("Note saved")).toBeTruthy();
    expect(scan(document.body)).toEqual([]);
  });

  it("a suggestion kept or discarded, and a note removed: each refusal, the question first and the done notes", async () => {
    board();
    const alert = () => screen.getByRole("alert").textContent ?? "";
    const keep = await refuseEach(noteActions.keepNoteAction, () => click("Keep the note about Marcus Hale"), alert);
    expect(new Set(keep).size).toBe(REFUSALS.length + 1);
    const discard = await refuseEach(noteActions.removeNoteAction, () => click("Discard the note about Marcus Hale"), alert);
    expect(new Set(discard).size).toBe(REFUSALS.length + 1);

    await click("Remove the note about Rosa Delgado");
    const question = () => screen.getByRole("group", { name: "Remove this note?" });
    expect(within(question()).getByText("The agent stops seeing it on the next question.")).toBeTruthy();
    expect(scan(document.body)).toEqual([]);
    const remove = await refuseEach(noteActions.removeNoteAction, () => click("Remove", question()), alert);
    expect(new Set(remove).size).toBe(REFUSALS.length + 1);
    noteActions.removeNoteAction.mockResolvedValueOnce({ ok: true });
    await click("Remove", question());
    expect(screen.getByText("Note removed")).toBeTruthy();
    noteActions.keepNoteAction.mockResolvedValueOnce({ ok: true });
    await click("Keep the note about Marcus Hale");
    expect(screen.getByText("Note kept")).toBeTruthy();
    noteActions.removeNoteAction.mockResolvedValueOnce({ ok: true });
    await click("Discard the note about Marcus Hale");
    expect(screen.getByText("Suggestion discarded")).toBeTruthy();
    expect(scan(document.body)).toEqual([]);
  });

  it("the page with Memory switched off", async () => {
    const switches = flags as Record<string, unknown>;
    const was = switches.carrierMemoryEnabled;
    switches.carrierMemoryEnabled = false;
    try {
      const container = await renderPage(async () => (await import("@/app/memory/page")).default());
      expect(container.textContent).toMatch(/Memory/);
      expect(container.textContent).toMatch(/off for this carrier/);
      expect(container.querySelector("table")).toBeNull();
      expect(scan(container)).toEqual([]);
    } finally {
      switches.carrierMemoryEnabled = was;
    }
  });
});

describe("no internal word on the profit brief, in every state", () => {
  const show = async () => renderPage(async () => (await import("@/app/profit/page")).default(sp()));

  it("the written brief, with each number a link to where it came from", async () => {
    state.fx.profitView = fx.profitView({ kind: "drafted", brief: fx.PROFIT_BRIEF, changed: false });
    const container = await show();
    const brief = screen.getByText(/^Revenue was/).closest("p");
    if (!brief) throw new Error("no brief paragraph");
    expect(within(brief).getAllByRole("link").map((a) => a.getAttribute("title"))).toEqual([
      "Revenue",
      "Driver pay",
      "Margin",
      "Margin percent",
      "Customer Tanglewood Grocery Supply: margin",
    ]);
    expect(brief.textContent).not.toMatch(/\[f\d+\]/);
    expect(scan(container)).toEqual([]);
  });

  it("the confirm before the agent writes, opened", async () => {
    const container = await show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Write this week's brief" }));
    });
    expect(screen.getByRole("button", { name: "Write the brief" })).toBeTruthy();
    expect(scan(container)).toEqual([]);
  });

  it("every sentence a press of the button or a stored refusal can show", () => {
    const categories = ["format", "unknown_tag", "number_mismatch", "untagged", "timeout", "interrupted", "incomplete", "cap", "too_expensive", "job_cap", "disabled", "not_configured", "error"];
    const errors = ["exists", "in_progress", "open_period", "no_loads", "not_found", "brief_off", "disabled", "ai_off", "ai_disabled", "forbidden", "unauthenticated", "unknown", "network"];
    const sentences = [
      ...categories.map(briefRefusalWords),
      ...errors.map((error) => writeOutcome({ ok: false, error, data: {} })),
      ...["drafted", "refused", "over_cap", "drafting"].flatMap((status) =>
        categories.map((category) => writeOutcome({ ok: true, error: null, data: { status, category } })),
      ),
    ];
    const { container } = render(
      <ul>
        {[...new Set(sentences)].map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>,
    );
    expect(sentences.every((t) => t.length > 0)).toBe(true);
    expect(scan(container)).toEqual([]);
  });

  it("the button to write it again, after a try that did not pass", () => {
    const { container } = render(
      <ToastProvider>
        <WriteBrief periodStart="2026-10-19" weekText="Oct 19 to Oct 25, 2026" again maxCents={6} />
      </ToastProvider>,
    );
    expect(screen.getByRole("button", { name: "Write the brief again" })).toBeTruthy();
    expect(scan(container)).toEqual([]);
  });

  it("the page with Profit brief switched off", async () => {
    const switches = flags as Record<string, unknown>;
    const was = switches.profitBriefEnabled;
    switches.profitBriefEnabled = false;
    try {
      const container = await show();
      expect(container.textContent).toMatch(/Profit brief/);
      expect(container.textContent).toMatch(/off for this carrier/);
      expect(container.querySelector("table")).toBeNull();
      expect(scan(container)).toEqual([]);
    } finally {
      switches.profitBriefEnabled = was;
    }
  });
});

describe("no internal word on the quarter review, in every state", () => {
  const show = async () => renderPage(async () => (await import("@/app/quarter/page")).default());

  it("the written review, with each number a link to where it came from", async () => {
    state.fx.quarterView = fx.quarterView({ kind: "drafted", review: fx.QUARTER_REVIEW, changed: false });
    const container = await show();
    const recovered = screen.getByRole("region", { name: "Money recovered" });
    expect(within(recovered).getAllByRole("link").map((a) => a.getAttribute("title"))).toEqual([
      "Detention recovered",
      "Advances recovered from pay",
    ]);
    expect(within(recovered).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "#quarter-recovered",
      "#quarter-recovered",
    ]);
    const change = screen.getByRole("region", { name: "Three things to change" });
    expect(within(change).getAllByRole("listitem")).toHaveLength(3);
    expect(container.textContent).not.toMatch(/\[f\d+\]/);
    expect(scan(container)).toEqual([]);
  });

  it("the confirm before the agent writes, opened", async () => {
    const container = await show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Write the quarter review" }));
    });
    expect(screen.getByRole("button", { name: "Write the review" })).toBeTruthy();
    expect(container.textContent).toMatch(/costs at most \$0\.30/);
    expect(scan(container)).toEqual([]);
  });

  it("every sentence a press of the button or a stored refusal can show", () => {
    const categories = ["format", "unknown_tag", "number_mismatch", "untagged", "timeout", "interrupted", "incomplete", "cap", "too_expensive", "job_cap", "disabled", "not_configured", "error", "rate_limited", "unavailable"];
    const errors = ["exists", "in_progress", "no_activity", "not_found", "review_off", "disabled", "ai_off", "ai_disabled", "forbidden", "unauthenticated", "unknown", "network"];
    const sentences = [
      ...categories.map(reviewRefusalWords),
      ...errors.map((error) => reviewOutcome({ ok: false, error, data: {} })),
      ...["drafted", "refused", "over_cap", "drafting"].flatMap((status) =>
        categories.map((category) => reviewOutcome({ ok: true, error: null, data: { status, category } })),
      ),
    ];
    const { container } = render(
      <ul>
        {[...new Set(sentences)].map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>,
    );
    expect(sentences.every((t) => t.length > 0)).toBe(true);
    expect(scan(container)).toEqual([]);
  });

  it("the button to write it again, after a try that did not pass", () => {
    const { container } = render(
      <ToastProvider>
        <WriteReview again maxCents={30} />
      </ToastProvider>,
    );
    expect(screen.getByRole("button", { name: "Write the quarter review again" })).toBeTruthy();
    expect(scan(container)).toEqual([]);
  });

  it("the page with Quarter review switched off", async () => {
    const switches = flags as Record<string, unknown>;
    const was = switches.quarterReviewEnabled;
    switches.quarterReviewEnabled = false;
    try {
      const container = await show();
      expect(container.textContent).toMatch(/Quarter review/);
      expect(container.textContent).toMatch(/off for this carrier/);
      expect(container.querySelector("table")).toBeNull();
      expect(scan(container)).toEqual([]);
    } finally {
      switches.quarterReviewEnabled = was;
    }
  });
});

describe("no internal word in a shared state", () => {
  it("every error, the empty, loading, off and not found states, the demo visit line, the test-mode banner and the top bar", () => {
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
        <DemoBanner carrier="Blue Ridge Freight" visitCapCents={flags.judgeAccess.sessionCapCents} />
        <TestModeBanner />
        <TopBar menu={null} agentOn testMode needsYouCount={2} offset />
      </>,
    );
    expect(container.textContent).toContain("Search or ask anything");
    expect(container.textContent).toContain("Test mode");
    expect(scan(container)).toEqual([]);
  });

  it("the agent launcher, and its card opened on a pay week's paystub with the chip on and the + menu open", async () => {
    // jsdom has no dialog methods; these stand in for the browser's, as the sheet's own test does.
    HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    const pending = globalThis.fetch;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ conversationId: null, turns: [] }), { status: 200 }));
    try {
      const config = {
        streamMode: "poll" as const,
        auditorOn: false,
        stepThrough: false,
        timezone: fx.TENANT.timezone,
        viewer: { admin: false, adminAboveCents: flags.approverRole.adminAboveCents },
        role: "staff" as const,
        greeting: greetingLine(fx.TENANT.name),
        documentsHref: "/documents",
      };
      const label = `Rosa Delgado, ${weekEnding("2026-10-25")}`;
      render(
        <AgentLauncher
          config={config}
          focus={{ table: "settlements", id: fx.ID, label }}
          suggestions={withPaystubSuggestion(defaultSuggestions(), { driverName: "Rosa Delgado", periodEnd: "2026-10-25" })}
        >
          <p>Page</p>
        </AgentLauncher>,
      );
      expect(scan(document.body)).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Ask the agent" }));
      const panel = await screen.findByRole("dialog", { name: "Agent" });
      await within(panel).findByRole("textbox", { name: "Your question" });
      expect(panel.textContent).toContain("About: Rosa Delgado, week ending Oct 25, 2026");
      expect(within(panel).getByRole("heading", { name: greetingLine(fx.TENANT.name) })).toBeTruthy();
      expect(within(panel).getByText("Beta")).toBeTruthy();
      expect(within(panel).getByRole("button", { name: "Minimize the agent" })).toBeTruthy();
      expect(within(panel).getByRole("button", { name: "Expand the agent" })).toBeTruthy();
      const menu = panel.querySelector("details");
      if (menu) menu.open = true;
      expect(within(panel).getByRole("button", { name: "New conversation" })).toBeTruthy();
      fireEvent.click(within(panel).getByRole("button", { name: "More ways to ask" }));
      expect(within(panel).getByRole("menu", { name: "More ways to ask" }).textContent).toContain("Upload a document");
      expect(scan(document.body)).toEqual([]);
    } finally {
      vi.stubGlobal("fetch", pending);
      Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
    }
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

describe("no internal word in the Cash page's notes and words", () => {
  it("every refusal after a press, card notice, reason the paragraph is not shown, table word and card reason", () => {
    const missing = ["figures", "disabled", "not_configured", "timeout", "cap", "job_cap", "too_expensive", "overclaim", "other"];
    const reasons = ["covers_short", "narrows_short", "factoring_test_mode", "bill_flexible", "due_before_pay_day", "repeat_late_payer", "past_due_balance", "collections_test_mode"];
    const words = [
      ...Object.values(CHECK_NOTICE),
      CHECK_NOT_CONFIRMED,
      OUT_OF_DATE,
      ...Object.values(CASH_CARD_NOTICES),
      ...missing.map((c) => explainMissing(c) ?? ""),
      ...Object.values(RECEIPT_STATUS_WORDS),
      ...Object.values(PAYER_WORDS),
      ...Object.values(BILL_CATEGORY_WORDS),
      ...Object.values(BILL_STATUS_WORDS),
      ...reasons.map(reasonSentence),
    ];
    expect(words.every((w) => w.length > 0)).toBe(true);
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

describe("no internal word in factoring's words", () => {
  it("every refusal, check result, status, planned and came-in line", () => {
    const w = factoringWords;
    const statuses = ["submitted", "unknown", "funded", "partly_funded", "declined", "failed"];
    const none = { confirmed: 0, failed: 0, tooNew: 0, stillWaiting: 0, stillUnknown: 0, errors: 0 };
    const words = [
      ...Object.values(w.FACTORING_APPROVE_NOTICE),
      ...Object.values(w.FACTORING_REFUSAL_SENTENCES),
      ...Object.values(w.CHECK_NOTICE),
      ...Object.values(w.CHECK_RESULT),
      ...Object.values(w.REQUEST_STATUS_WORDS),
      w.checkResultSentence({ ...none, errors: 1 }),
      w.PLANNED_LABEL,
      w.plannedLine("$5,611.50", "$645.00", "$193.50"),
      ...statuses.flatMap((s) => [w.cameInLabel(s), w.cameInLine(s, "$1,870.50")]),
      w.TEST_MODE_HELP,
    ];
    expect(words.every((x) => x.length > 0)).toBe(true);
    const { container } = render(
      <ul>
        {words.map((x, n) => (
          <li key={n}>{x}</li>
        ))}
      </ul>,
    );
    expect(scan(container)).toEqual([]);
  });
});

describe("no internal word in a collections note", () => {
  it("every status, tone, refusal, approval, run and error line", () => {
    const words = [
      ...Object.values(REMINDER_STATUS_WORDS),
      ...Object.values(TONE_WORDS),
      TONE_HELP,
      ...[...Object.keys(REFUSAL_WORDS), null, "unheard_of"].map(refusalWords),
      approvedWords("logged", null, fx.TENANT.timezone),
      approvedWords("email", null, fx.TENANT.timezone),
      approvedWords("email", "2026-10-27T15:05:00.000Z", fx.TENANT.timezone),
      draftedWords(1, 0),
      draftedWords(3, 1),
      ...[null, "cap", "model"].flatMap((stoppedBy) => [stillWaitingWords(1, stoppedBy) ?? "", stillWaitingWords(4, stoppedBy) ?? ""]),
      ...Object.values(DRAFT_ERROR_WORDS),
      ...Object.values(DECIDE_ERROR_WORDS),
      UNCONFIRMED_DECISION_WORDS.title,
      UNCONFIRMED_DECISION_WORDS.body,
      EMAIL_UNCONFIRMED_WORDS,
    ];
    const { container } = render(
      <ul>
        {words.map((w, n) => (
          <li key={n}>{w}</li>
        ))}
      </ul>,
    );
    expect(words.every((w) => w.length > 0)).toBe(true);
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
      await click("Keep reviewing");
      for (const error of ["refused", "unknown"]) {
        answer(error);
        // Reject asks once: open its question when it is not open, then reject from inside it.
        if (!screen.queryByRole("group", { name: "Confirm rejection" })) await click("Reject");
        await act(async () => {
          fireEvent.click(within(screen.getByRole("group", { name: "Confirm rejection" })).getByRole("button", { name: "Reject" }));
        });
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

describe("no internal word on a pay rule change", () => {
  const ADMIN = { admin: true, adminAboveCents: flags.approverRole.adminAboveCents };
  const STAFF = { admin: false, adminAboveCents: flags.approverRole.adminAboveCents };
  const cardOf = (v: (typeof fx.RULE_CHANGES)[number], on = true): RuleChangeCard => ({
    card: proposalCardFrom(v, on ? { on: true, checking: false } : undefined, ADMIN),
    verdict: v.auditorVerdict,
    flagged: v.flagged,
  });
  const click = async (name: string | RegExp) => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  };
  // Every POST answers with this refusal category; with none, it succeeds.
  const answer = (error: string | null) =>
    vi.stubGlobal("fetch", async () =>
      error === null ? new Response(JSON.stringify({ ok: true }), { status: 200 }) : new Response(JSON.stringify({ error }), { status: 409 }),
    );

  it("every card in the chat, waiting and decided, for an admin and for staff, with the second check on and off", () => {
    const cards = [...fx.RULE_CHANGES, ...fx.RULE_CHANGES_DECIDED];
    const notices = Object.fromEntries(cards.map((c, n) => [c.id, Object.values(payWords.SAVE_NOTICES)[n % Object.keys(payWords.SAVE_NOTICES).length]]));
    const turn: TurnView = { ...fx.TURNS[0], proposals: cards };
    for (const viewer of [ADMIN, STAFF]) {
      for (const on of [true, false]) {
        const checking = Object.fromEntries(cards.filter((c) => c.auditorVerdict === null).map((c) => [c.id, true]));
        const messages = toMessages([turn], notices, {}, undefined, { on, checking, timezone: fx.TENANT.timezone }, viewer);
        const { container, unmount } = render(<ChatThread messages={messages} composer={{}} />);
        expect(container.textContent).toContain(payWords.NOTHING_CHANGES);
        expect(scan(container)).toEqual([]);
        unmount();
      }
    }
  });

  it("every card on the Pay rules page, while the second check runs", async () => {
    await act(async () => {
      render(<RuleChangeCards cards={fx.RULE_CHANGES.map((v) => cardOf(v))} auditorOn />);
    });
    expect(document.body.textContent).toContain(payWords.AUDIT_LINES.checking);
    expect(scan(document.body)).toEqual([]);
  });

  it("every note under a card after Save and Not now", async () => {
    render(<RuleChangeCards cards={[cardOf(fx.RULE_CHANGES[0])]} />);
    const hits: Hit[] = [];
    const seen = new Set<string>();
    const read = () => {
      for (const s of screen.queryAllByRole("status")) if (s.textContent) seen.add(s.textContent);
      hits.push(...scan(document.body));
    };
    try {
      for (const error of [...Object.keys(payWords.SAVE_NOTICES), "refused", "unavailable", null]) {
        answer(error);
        if (!screen.queryByRole("button", { name: "Confirm" })) await click(payWords.SAVE_LABEL);
        await click("Confirm");
        read();
      }
      await click("Keep reviewing");
      for (const error of ["refused", "unknown"]) {
        answer(error);
        // Not now asks once, like every Reject; the question's own Reject sends it.
        if (!screen.queryByRole("group", { name: "Confirm rejection" })) await click(payWords.NOT_NOW_LABEL);
        await click("Reject");
        read();
      }
    } finally {
      vi.stubGlobal("fetch", () => new Promise(() => {}));
    }
    // Each refusal left its own note (the empty ones say nothing more), so every path above was read.
    expect(seen.size).toBeGreaterThanOrEqual(10);
    expect(hits).toEqual([]);
  });

  it("every fixed line, rule label, hover help and value, and every line the figures write", () => {
    const fixed = Object.values(payWords).flatMap((w) => (typeof w === "string" ? [w] : typeof w === "object" && w !== null ? Object.values(w) : []));
    const impact = fx.RULE_CHANGES[0].ruleChange!.impact;
    const words = [
      ...fixed,
      ...RULE_KEYS.flatMap((key) => {
        const spec = RULES[key];
        const values = spec.values ?? [spec.min, spec.max, ...(spec.nullable ? [null] : [])];
        return [
          labelFor(key, "owner_operator"),
          labelFor(key, "all"),
          spec.help,
          ...values.map((v) => formatValue(spec, v)),
          payWords.ruleTitle({ ruleKey: key, oldValue: values[0], newValue: values[values.length - 1], appliesTo: "owner_operator" }),
        ];
      }),
      ...[true, false].map((snapped) => payWords.startsLine({ effectiveFrom: "2026-11-09", askedFrom: "2026-11-04", snapped })),
      ...(["settled_week", "no_settled_week", "advances_only"] as const).flatMap((basis) =>
        [0, 1, 4].flatMap((driversChanged) =>
          [true, false].flatMap((ownerOperatorsOnly) =>
            [-2_400, 0, 4_100].map((netDeltaCents) => payWords.impactLine({ ...impact, basis, driversChanged, ownerOperatorsOnly, netDeltaCents })),
          ),
        ),
      ),
      ...[-1, 0, 1].map((n) => payWords.impactLabel(n)),
      payWords.adminOnlyLabel(flags.approverRole.adminAboveCents),
      payWords.adminOnlyLabel(250_050),
      payWords.savedLine("2026-11-09"),
      payWords.paidUnderLine("2026-10-19"),
      payWords.composerHelp(fx.NEXT_START),
      payWords.exampleSentence(fx.NEXT_START),
      payWords.shortPeriod("2026-10-26", "2026-11-01"),
    ];
    const { container } = render(
      <ul>
        {words.map((w, n) => (
          <li key={n}>{w}</li>
        ))}
      </ul>,
    );
    expect(words.length).toBeGreaterThan(60);
    expect(scan(container)).toEqual([]);
  });
});

describe("the advances pages read by driver and date", () => {
  it("lists the driver first, then when, how much, the fee, where it stands and where it was paid", async () => {
    await renderPage(async () => (await import("@/app/advances/page")).default(sp()));
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Driver",
      "Requested",
      "Amount",
      "Fee",
      "Status",
      "Paid to",
    ]);
    const row = fx.ADVANCES[0];
    const link = screen.getAllByRole("link", { name: new RegExp(`^Advance for ${row.driverName}, `) })[0];
    expect(link.getAttribute("href")).toBe(`/records/advances/${row.id}`);
  });

  it("titles an advance record with the driver's name and the day it was asked for", async () => {
    await renderPage(async () => (await import("@/app/records/advances/[id]/page")).default({ params: p({ id: ID }) }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Advance for Rosa Delgado, Oct 28, 2026/);
  });

  it("names the driver's other advances on the load by amount, adding the reference only when two match", async () => {
    const sibling = fx.ADVANCE_RECORD.siblingsOnLoad[0];
    await renderPage(async () => (await import("@/app/records/advances/[id]/page")).default({ params: p({ id: ID }) }));
    expect(screen.getByRole("link", { name: "Advance of $100.00" }).getAttribute("href")).toBe(`/records/advances/${sibling.id}`);
    expect(screen.queryByText(sibling.requestRef)).toBeNull();
    cleanup();

    const twin = { ...sibling, id: "0b9f6a52-3c1d-4e8f-9a7b-000000000099", requestRef: "ADV-1041" };
    state.fx.advanceRecord = { ...fx.ADVANCE_RECORD, siblingsOnLoad: [sibling, twin] };
    await renderPage(async () => (await import("@/app/records/advances/[id]/page")).default({ params: p({ id: ID }) }));
    expect(screen.getByRole("link", { name: "Advance of $100.00, ADV-1040" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Advance of $100.00, ADV-1041" })).toBeTruthy();
  });
});

// The Fuel and tax rates page's words that show only after a click (a lookup's or a pin's note, the
// typed form, the confirm), each read once, every category included.
describe("no internal word on the rates page's notes and forms", () => {
  it("every fixed line, note and confirm", () => {
    const categories = [
      "suggested",
      "unconfirmed",
      "no_source",
      "limit",
      "budget",
      "forbidden",
      "disabled",
      "unknown",
      "failed",
      "pinned",
      "already",
      "changed",
      "not_found",
      "bad_request",
      "unavailable",
    ];
    const words = [
      ...Object.values(RATES_WORDS),
      ...categories.flatMap((c) => [lookupNotice(c).text, pinNotice(c).text]),
      pinQuestion("$3.657"),
      pinNext("Oct 26, 2026"),
      pinnedFromLine("Oct 19, 2026"),
      ...[0, 1, 20].map(lookupsLeftLine),
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

describe("the money code record page", () => {
  it("describes the receipt by what it is, never as a photo or an image", async () => {
    await renderPage(async () => (await import("@/app/money-codes/[id]/page")).default({ params: p({ id: ID }) }));
    const alt = screen.getByRole("img", { name: /receipt/ }).getAttribute("alt");
    expect(alt).toBe(`The receipt, ${fx.MONEY_CODE_DETAIL.receipt?.filename}`);
    expect(alt).not.toMatch(/photo|image|picture/i);
  });
});

describe("no internal word on the pay cards board, in every state", () => {
  const rows = (): BoardRow[] =>
    fx.PERIOD_CARDS.rows.map((r) => ({
      settlementId: r.settlementId,
      driverName: r.driverName,
      spec: r.spec,
      pill: r.pill,
      reason: r.reason,
      checkedId: r.checkedId,
      attemptsUsed: r.attemptsUsed,
    }));
  const board = (offReason?: string) =>
    render(
      <ToastProvider>
        <CardsBoard rows={rows()} offReason={offReason} maxPngBytes={400_000} />
      </ToastProvider>,
    );
  const make = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Make 6 pay cards/ }));
    });
  };
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  afterEach(() => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
  });

  it("while a card is being checked", async () => {
    board();
    await make();
    expect(screen.getAllByText("Checking card 1 of 6").length).toBeGreaterThan(0);
    expect(scan(document.body)).toEqual([]);
  });

  it("every answer a check can give, one card each, and a refusal that skips one card", async () => {
    const answers = [
      answer(200, { status: "checked", cardId: "0b9f6a52-3c1d-4e8f-9a7b-000000000690" }),
      answer(200, { status: "mismatch", category: "number_mismatch" }),
      answer(200, { status: "mismatch", category: "text_mismatch" }),
      answer(200, { status: "unavailable", category: "off_schema" }),
      answer(409, { error: "busy" }),
      answer(200, { status: "unavailable", category: "timeout" }),
    ];
    vi.stubGlobal("fetch", async () => answers.shift() ?? answer(500, {}));
    board();
    await make();
    expect(screen.getByText("Wait a moment.", { exact: false })).toBeTruthy();
    expect(screen.getAllByText("Save image").length).toBe(2);
    expect(scan(document.body)).toEqual([]);
  });

  it("each refusal that stops the run, and a check lost on the way", async () => {
    for (const code of ["cards_off", "ai_off", "budget", "batch_cap", "day_cap", "forbidden", "unauthenticated"]) {
      vi.stubGlobal("fetch", async () => answer(403, { error: code }));
      board();
      await make();
      expect(screen.getByText("Pay cards stopped")).toBeTruthy();
      expect(scan(document.body), code).toEqual([]);
      cleanup();
    }
    vi.stubGlobal("fetch", async () => {
      throw new Error("lost on the way");
    });
    board();
    await make();
    expect(screen.getByText(CARD_ERROR_FALLBACK)).toBeTruthy();
    expect(scan(document.body), "lost").toEqual([]);
  });

  it("with the models switched off", () => {
    board("The models are switched off, so no card can be checked right now.");
    expect(screen.getByRole("button", { name: /Make 6 pay cards/ })).toHaveProperty("disabled", true);
    expect(scan(document.body)).toEqual([]);
  });

  it("every pill, reason, refusal and card line, in both languages", () => {
    const { periodStart, periodEnd } = fx.PERIOD_CARDS.period;
    const words = [
      ...fx.PERIOD_CARDS.rows.flatMap((r) => Object.values(r.spec.text).filter((t): t is string => t !== null)),
      ...Object.values(CARD_PILL_WORDS),
      ...Object.values(CARD_REASON_WORDS),
      ...Object.values(CARD_ERROR_WORDS),
      CARD_ERROR_FALLBACK,
      ...(["en", "es"] as const).flatMap((lang) => {
        const w = CARD_WORDS[lang];
        return [
          w.title,
          w.week(periodStart, periodEnd),
          w.netLabel,
          w.earned(141_200),
          w.takenOut(31_000),
          w.loads(1),
          w.loads(4),
          w.miles(1),
          w.miles(2_310),
          w.up(1_250),
          w.down(1_250),
          w.same,
          w.firstWeek,
          w.topChange(w.kind("fuel"), -4_500),
          w.carried(2_000),
          w.approved,
          w.paid,
          w.testMode,
          ...["load_pay", "fuel", "lease", "escrow", "carried_shortfall"].map(w.kind),
        ];
      }),
    ];
    expect(words.every((w) => w.length > 0)).toBe(true);
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
