// The rules engine: pure functions over plain records, integer cents, per-tenant config. No
// database, clock, environment or network. Callers read records, call these, and write results.
export * from "./types";
export {
  assertCents,
  assertCount,
  BPS,
  cents,
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
  findAdvanceOverLoadCap,
  findDeliveredWithoutRate,
  findDuplicateAdvances,
  findFuelOnWrongDriver,
  findInsuranceDaysNotDriven,
  findMissingReimbursements,
  findOverAdvanceLimit,
  runAllChecks,
} from "./checks";
export {
  ageReceivables,
  agingBucket,
  findPaymentOnWrongInvoice,
  invoiceStatus,
  paymentProfile,
} from "./receivables";
export {
  detentionCents,
  detentionStops,
  findUnbilledDetention,
  lastFullMonthBefore,
} from "./detention";
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
