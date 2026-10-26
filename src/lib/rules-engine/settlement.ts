import { isWithin } from "../time/local-date";
import { assertPayConfig, checkDriver } from "./config";
import {
  checkDay,
  checkItem,
  checkSchedule,
  escrowLine,
  hardDeductionLines,
  itemLines,
} from "./deductions";
import {
  accessorialPay,
  byLoadNumber,
  checkLoad,
  isDelivered,
  loadPay,
  type LineDraft,
} from "./load-pay";
import { assertCents, cents, sub, sum } from "./money";
import { checkAdvance, recoverAdvances } from "./recovery";
import {
  assertPeriod,
  type ExceptionLine,
  type SettlementInput,
  type SettlementNote,
  type SettlementResult,
} from "./types";

// One driver's pay for one period. The order below is the contract (design section 3):
//   1. load pay, then accessorial pay      2. reimbursements      3. gross = 1 + 2
//   4. hard deductions, always taken       5. below zero: net 0 and carry the rest forward
//   6. escrow, above the floor             7. advance recovery, above the floor
//   8. net = what is left
// Pure: it reads only its input and writes nothing. Every line cites its records.
export function settleDriver(input: SettlementInput): SettlementResult {
  const config = assertPayConfig(input.config);
  const driver = checkDriver(input.driver);
  const period = assertPeriod(input.period);
  const balance = assertCents(input.escrowBalanceCents, "escrowBalanceCents");
  const loads = input.loads.map((l) => checkLoad(l, driver.id));
  const days = input.days.map((d) => checkDay(d, driver.id));
  const items = input.items.map((i) => checkItem(i, driver.id));
  const schedules = input.schedules.map((s) => checkSchedule(s, driver.id));
  const advances = input.advances.map((a) => checkAdvance(a, driver.id));

  // 1. Loads delivered in the period, in load number order.
  const delivered = loads
    .filter((l) => isDelivered(l) && l.deliveredOn !== null && isWithin(l.deliveredOn, period))
    .sort(byLoadNumber);
  const exceptions: ExceptionLine[] = [];
  const loadLines: LineDraft[] = [];
  for (const load of delivered) {
    const pay = loadPay(config, driver, load);
    loadLines.push(pay.line);
    if (pay.exception) exceptions.push(pay.exception);
  }
  const accessorialLines = delivered
    .map((l) => accessorialPay(config, driver, l))
    .filter((l): l is LineDraft => l !== null);

  // 2 and 3.
  const reimbursementLines = itemLines(items, "reimbursement", period);
  const earnings = [...loadLines, ...accessorialLines, ...reimbursementLines];
  const gross = sum(earnings.map((l) => l.amountCents));

  // 4 and 5.
  const hard = hardDeductionLines(config, driver, period, items, schedules, days);
  const afterHard = sum([gross, ...hard.lines.map((l) => l.amountCents)]);
  const notes: SettlementNote[] = [];
  let tail: LineDraft[] = [];
  let net = cents(0);
  let carryForward = cents(0);
  let escrowDelta = cents(0);
  let recoveries: SettlementResult["recoveries"] = [];
  if (afterHard < 0) {
    carryForward = sub(0, afterHard);
    exceptions.push({
      kind: "net",
      category: "net_below_zero",
      sources: [{ table: "drivers", id: driver.id }],
      amountCents: carryForward,
    });
  } else {
    // 6.
    const escrow = escrowLine(config, schedules, period, balance, afterHard);
    if (escrow.note) notes.push(escrow.note);
    escrowDelta = escrow.deltaCents;
    const afterEscrow = sub(afterHard, escrowDelta);
    // 7. The floor limits only escrow and recovery.
    const room = cents(Math.max(0, sub(afterEscrow, config.netPayFloorCents)));
    const recovery = recoverAdvances(config, advances, period, room);
    if (recovery.note) notes.push(recovery.note);
    recoveries = recovery.recoveries;
    tail = [...(escrow.line ? [escrow.line] : []), ...recovery.lines];
    // 8.
    net = sub(afterEscrow, recovery.recoveredCents);
  }

  const drafts = [...earnings, ...hard.lines, ...tail];
  const lines = drafts.map((l, i) => ({ seq: i + 1, ...l }));
  const deductions = sub(0, sum([...hard.lines, ...tail].map((l) => l.amountCents)));
  // The identity every paystub must satisfy; a break here is a bug, never a payable number.
  if (sum([gross, sub(0, deductions), carryForward]) !== net) {
    throw new Error("settlement lines do not add up to the net");
  }
  return {
    lines,
    exceptions,
    notes,
    grossCents: gross,
    deductionsCents: deductions,
    netCents: net,
    carryForwardCents: carryForward,
    recoveries,
    escrowDeltaCents: escrowDelta,
    insuredDays: hard.insuredDays,
  };
}
