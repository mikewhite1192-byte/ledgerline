// The rules engine: pure functions over plain records, integer cents, per-tenant config. No
// database, clock, environment or network. Callers read records, call these, and write results.
export * from "./types";
export {
  assertCents,
  assertCount,
  BPS,
  cents,
  floorDiv,
  MAX_STORED_CENTS,
  mul,
  mulBps,
  roundHalfUp,
  sub,
  sum,
} from "./money";
export {
  advanceLimitOf,
  assertPayConfig,
  checkDriver,
  driverRate,
  insuranceApplies,
  parsePayConfig,
} from "./config";
export type { DriverRate } from "./config";
export {
  accessorialPay,
  assertStateMiles,
  checkLoad,
  driverPayOnLoad,
  earnedUnpaid,
  isDelivered,
  loadPay,
  PAID_STATUSES,
  PAYABLE_ACCESSORIALS,
  percentBaseCents,
} from "./load-pay";
export type { LineDraft } from "./load-pay";
export {
  activeSchedule,
  checkDay,
  checkItem,
  checkSchedule,
  escrowLine,
  hardDeductionLines,
  insuranceLine,
  itemLines,
  leaseLine,
  scheduleActive,
} from "./deductions";
export { checkAdvance, DUPLICATE_WINDOW_MS, outstandingCents, recoverAdvances } from "./recovery";
export { settleDriver } from "./settlement";
export { advanceEligibility, floorToDollars } from "./advances";
export { invoiceAmount } from "./invoices";
export {
  differingRateConfirmations,
  DOCUMENT_KINDS,
  DUPLICATE_WINDOW_DAYS,
  INVOICE_REVIEW_REASONS,
  INVOICE_REVIEW_STATUSES,
  inReviewQueue,
  POSTING_STATES,
  REVIEW_STATUS_OF,
  reviewInvoice,
} from "./invoice-review";
export type {
  DocumentFact,
  DocumentKind,
  InvoiceReview,
  InvoiceReviewInput,
  InvoiceReviewReason,
  InvoiceReviewStatus,
  PostingState,
} from "./invoice-review";
export {
  findAdvanceOverLoadCap,
  findDeliveredWithoutRate,
  findDuplicateAdvances,
  findFuelOnWrongDriver,
  findInsuranceDaysNotDriven,
  findMissingReimbursements,
  findOverAdvanceLimit,
  RUN_ALL_CHECKS,
  runAllChecks,
} from "./checks";
export {
  ageReceivables,
  agingBucket,
  daysToPay,
  findPaymentOnWrongInvoice,
  invoiceStatus,
  paymentProfile,
} from "./receivables";
export type { DaysToPay } from "./receivables";
export {
  COLLECTION_STAGES,
  COLLECTION_TONES,
  collectionStage,
  collectionTone,
  planCollections,
} from "./collections";
export type { ChaseCandidate, CollectionStage, CollectionTone } from "./collections";
export {
  detentionCents,
  detentionStops,
  findUnbilledDetention,
  lastFullMonthBefore,
} from "./detention";
export {
  checkMoneyCode,
  MONEY_CODE_ACTIVE_DAYS,
  MONEY_CODE_DUPLICATE_MS,
  MONEY_CODE_PURPOSES,
  MONEY_CODE_REASONS,
  MONEY_CODE_REFUSALS,
  MONEY_CODE_SOURCES,
  MONEY_CODE_STATUSES,
} from "./money-codes";
export type {
  MoneyCodeDecision,
  MoneyCodeInput,
  MoneyCodeLoad,
  MoneyCodePurpose,
  MoneyCodeReason,
  MoneyCodeReceipt,
  MoneyCodeRecord,
  MoneyCodeRefusal,
  MoneyCodeSource,
  MoneyCodeStatus,
  MoneyCodeVoice,
} from "./money-codes";
export {
  billDeferOption,
  billsDue,
  chaseOptions,
  CHASE_INVOICES_MAX,
  computeCashFriday,
  DEFER_DAYS,
  expectedReceipts,
  factoringOption,
  NO_HISTORY_ON_TIME_BPS,
  onTimeBps,
  openInvoices,
  payDayFor,
  typicalDaysLate,
  TYPICAL_DAYS_LATE_DEFAULT,
  type OpenInvoice,
} from "./cash-friday";
export {
  customerPaying,
  FIGURE_KINDS,
  FIGURE_SECTIONS,
  marginBpsOf,
  profitFigures,
  profitTotals,
  rollupByCustomer,
  rollupByLane,
  routeOf,
} from "./profit";
export type {
  BriefFigure,
  CustomerPaying,
  CustomerRollup,
  FigureKind,
  FigureSection,
  FigureSource,
  LaneRollup,
  ProfitFigureLimits,
  ProfitLine,
  ProfitTotals,
} from "./profit";
export { fixWords, QUARTER_CUSTOMERS, QUARTER_DRIVERS, quarterFigures, quarterOf } from "./quarter";
export type {
  Quarter,
  QuarterCustomer,
  QuarterDetentionCharge,
  QuarterDriver,
  QuarterFixes,
  QuarterInput,
  QuarterPayRun,
  QuarterProposal,
} from "./quarter";
export {
  FUEL_CATEGORY_OF,
  FUEL_CHECK_NAMES,
  findFuelDuplicate,
  findFuelOffRoute,
  findFuelOverTank,
  findFuelWhileParked,
  NO_SUGGESTION_REASONS,
  overTankExcessCents,
  runFuelChecks,
  suggestedCorrection,
} from "./fuel";
export type { FuelCategory, FuelCheckName, FuelFinding, FuelLimits, NoSuggestionReason } from "./fuel";
export { PINNED_RATE_KINDS, rateOn } from "./rates";
export type { PinnedRate, PinnedRateKind } from "./rates";
