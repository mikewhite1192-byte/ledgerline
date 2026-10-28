import { daysBetween, type Instant, type LocalDate } from "../time/local-date";
import { assertCount } from "./money";
import { assertDate, assertId, assertOneOf, instantMs, type Cents, type LoadStatus } from "./types";

// May this driver have a one-time money code for this amount on this load now? Pure: the caller
// reads the load, the driver's arming, the cited receipt or voice note and the recent codes, and
// a person approves what this allows. The engine moves nothing.
//
// Rules, every one checked, refusals listed in the fixed order of MONEY_CODE_REFUSALS:
//   the load is this driver's, and in transit or delivered within MONEY_CODE_ACTIVE_DAYS of today
//     (an invoiced load counts as delivered, except for a lumper: its billable line needs a load
//     not invoiced yet)
//   the amount is a positive whole number of cents at or under the cap
//   a cited document was read, with the kind, total and load number not marked low; its kind fits
//     the purpose; its total equals the amount (whole value); its load number is this load's
//   a cited voice note came from this driver (a note from no known driver backs no code) and one
//     of its spoken amounts equals the amount
//   the driver is armed for money
//   no other live code on this load for the same purpose and amount in the last 24 hours
//   at most perDriverPerDay live codes for this driver on the tenant-local day
// A failed or voided code is not live: it counts for neither the duplicate nor the daily limit.

export const MONEY_CODE_PURPOSES = ["lumper", "repair", "other"] as const;
export type MoneyCodePurpose = (typeof MONEY_CODE_PURPOSES)[number];

export const MONEY_CODE_SOURCES = ["document", "voice_note", "chat", "form"] as const;
export type MoneyCodeSource = (typeof MONEY_CODE_SOURCES)[number];

export const MONEY_CODE_STATUSES = ["issuing", "issued", "failed", "unknown", "voided"] as const;
export type MoneyCodeStatus = (typeof MONEY_CODE_STATUSES)[number];
const LIVE_STATUSES: readonly MoneyCodeStatus[] = ["issuing", "issued", "unknown"];

export const MONEY_CODE_REFUSALS = [
  "load_not_drivers",
  "load_not_active",
  "load_invoiced",
  "amount_invalid",
  "over_code_cap",
  "evidence_missing",
  "receipt_unreadable",
  "receipt_kind",
  "receipt_total_differs",
  "receipt_other_load",
  "voice_other_driver",
  "voice_driver_unmatched",
  "voice_amount_differs",
  "driver_not_armed",
  "duplicate_code",
  "daily_limit",
] as const;
export type MoneyCodeRefusal = (typeof MONEY_CODE_REFUSALS)[number];

export const MONEY_CODE_REASONS = [
  "load_in_transit",
  "load_delivered_recently",
  "receipt_total_matches",
  "voice_amount",
  "driver_armed",
] as const;
export type MoneyCodeReason = (typeof MONEY_CODE_REASONS)[number];

// Days after delivery a code may still be issued for the load.
export const MONEY_CODE_ACTIVE_DAYS = 3;
// Same load, purpose and amount inside this window is a duplicate.
export const MONEY_CODE_DUPLICATE_MS = 24 * 60 * 60 * 1000;

// A receipt's document kind for each purpose. A repair or other receipt reads as "other".
const RECEIPT_KIND: Record<MoneyCodePurpose, string> = {
  lumper: "lumper_receipt",
  repair: "other",
  other: "other",
};

type Confidence = "low" | "medium" | "high";

export type MoneyCodeLoad = {
  id: string;
  driverId: string | null;
  status: LoadStatus;
  loadNumber: string;
  deliveredOn: LocalDate | null;
};

// The cited document as stored: its read status and, when read, the reading's fields.
export type MoneyCodeReceipt = {
  readStatus: "pending" | "read" | "unreadable" | "budget";
  kind: string | null;
  totalCents: number | null;
  loadNumber: string | null;
  kindConfidence: Confidence | null;
  totalConfidence: Confidence | null;
  loadNumberConfidence: Confidence | null;
};

// The cited voice note: who sent it (null when the sender was not matched to a driver) and the
// amounts its English text speaks, in cents.
export type MoneyCodeVoice = { driverId: string | null; amountsCents: readonly number[] };

export type MoneyCodeRecord = {
  id: string;
  driverId: string;
  loadId: string;
  purpose: MoneyCodePurpose;
  amountCents: number;
  status: MoneyCodeStatus;
  createdAt: Instant;
  // The tenant-local day the code was created.
  createdOn: LocalDate;
};

export type MoneyCodeInput = {
  driverId: string;
  driverArmed: boolean;
  // null when no such load exists in this carrier.
  load: MoneyCodeLoad | null;
  purpose: MoneyCodePurpose;
  // As asked; anything but a positive whole number is amount_invalid, never a throw.
  amountCents: unknown;
  capCents: number;
  perDriverPerDay: number;
  now: Instant;
  // The tenant-local day of now.
  today: LocalDate;
  source: MoneyCodeSource;
  // Required for a document source, null when the document was not found.
  receipt: MoneyCodeReceipt | null;
  // Required for a voice-note source, null when the note was not found or is not ready.
  voice: MoneyCodeVoice | null;
  // This driver's and this load's codes, without the one the current request already made.
  codes: readonly MoneyCodeRecord[];
};

export type MoneyCodeDecision =
  | { ok: true; amountCents: Cents; purpose: MoneyCodePurpose; reasons: MoneyCodeReason[] }
  | { ok: false; category: MoneyCodeRefusal; refusals: MoneyCodeRefusal[] };

// The same whole-value text compare the document match uses: spaces collapsed, upper case.
function normText(s: string | null): string | null {
  if (s === null) return null;
  const out = s.trim().replace(/\s+/g, " ").toUpperCase();
  return out === "" ? null : out;
}

function validAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// An invoiced load was delivered, so it counts by its delivery day like a delivered one. Whether a
// lumper may still use it is checked apart (load_invoiced).
function loadActive(load: MoneyCodeLoad, today: LocalDate): MoneyCodeReason | null {
  if (load.status === "in_transit") return "load_in_transit";
  if ((load.status !== "delivered" && load.status !== "invoiced") || load.deliveredOn === null) return null;
  const days = daysBetween(load.deliveredOn, today);
  return days >= 0 && days <= MONEY_CODE_ACTIVE_DAYS ? "load_delivered_recently" : null;
}

// A field the reading did not mark low (or leave without a confidence).
const sure = (c: Confidence | null): boolean => c === "medium" || c === "high";

function receiptRefusal(
  receipt: MoneyCodeReceipt | null,
  purpose: MoneyCodePurpose,
  amount: number | null,
  load: MoneyCodeLoad | null,
): MoneyCodeRefusal[] {
  if (receipt === null) return ["evidence_missing"];
  if (
    receipt.readStatus !== "read" ||
    !validAmount(receipt.totalCents) ||
    !sure(receipt.kindConfidence) ||
    !sure(receipt.totalConfidence) ||
    !sure(receipt.loadNumberConfidence)
  ) {
    return ["receipt_unreadable"];
  }
  const out: MoneyCodeRefusal[] = [];
  if (receipt.kind !== RECEIPT_KIND[purpose]) out.push("receipt_kind");
  if (amount !== null && receipt.totalCents !== amount) out.push("receipt_total_differs");
  const printed = normText(receipt.loadNumber);
  if (printed === null || load === null || printed !== normText(load.loadNumber)) {
    out.push("receipt_other_load");
  }
  return out;
}

function voiceRefusal(voice: MoneyCodeVoice | null, driverId: string, amount: number | null): MoneyCodeRefusal[] {
  if (voice === null) return ["evidence_missing"];
  const out: MoneyCodeRefusal[] = [];
  // A sender matched to no driver could be anyone, so the note backs no driver's code.
  if (voice.driverId === null) out.push("voice_driver_unmatched");
  else if (voice.driverId !== driverId) out.push("voice_other_driver");
  if (amount === null || !voice.amountsCents.some((a) => a === amount)) out.push("voice_amount_differs");
  return out;
}

export function checkMoneyCode(input: MoneyCodeInput): MoneyCodeDecision {
  const driverId = assertId(input.driverId, "driverId");
  const purpose = assertOneOf(input.purpose, MONEY_CODE_PURPOSES, "purpose");
  const source = assertOneOf(input.source, MONEY_CODE_SOURCES, "source");
  const cap = assertCount(input.capCents, "capCents");
  const perDay = assertCount(input.perDriverPerDay, "perDriverPerDay");
  const nowMs = instantMs(input.now, "now");
  const today = assertDate(input.today, "today");
  const amount = validAmount(input.amountCents) ? input.amountCents : null;
  const load = input.load;

  const found = new Set<MoneyCodeRefusal>();
  const reasons: MoneyCodeReason[] = [];

  if (load === null || load.driverId !== driverId) found.add("load_not_drivers");
  const active = load === null ? null : loadActive(load, today);
  if (load !== null && active === null) found.add("load_not_active");
  if (active !== null) reasons.push(active);
  // A lumper code also writes a billable lumper line for the load's invoice, which an invoiced load
  // no longer takes.
  if (load !== null && load.status === "invoiced" && purpose === "lumper") found.add("load_invoiced");

  if (amount === null) found.add("amount_invalid");
  else if (amount > cap) found.add("over_code_cap");

  if (source === "document") {
    const refusals = receiptRefusal(input.receipt, purpose, amount, load);
    for (const r of refusals) found.add(r);
    if (refusals.length === 0) reasons.push("receipt_total_matches");
  } else if (source === "voice_note") {
    const refusals = voiceRefusal(input.voice, driverId, amount);
    for (const r of refusals) found.add(r);
    if (refusals.length === 0) reasons.push("voice_amount");
  }

  if (input.driverArmed === true) reasons.push("driver_armed");
  else found.add("driver_not_armed");

  const live = input.codes.filter((c) => LIVE_STATUSES.includes(c.status));
  if (
    amount !== null &&
    load !== null &&
    live.some((c) => {
      if (c.loadId !== load.id || c.purpose !== purpose || c.amountCents !== amount) return false;
      // A code stamped after now (clock skew) counts too: unknown is not old.
      return nowMs - instantMs(c.createdAt, "code createdAt") < MONEY_CODE_DUPLICATE_MS;
    })
  ) {
    found.add("duplicate_code");
  }
  const todays = live.filter((c) => c.driverId === driverId && assertDate(c.createdOn, "code createdOn") === today);
  if (todays.length >= perDay) found.add("daily_limit");

  const refusals = MONEY_CODE_REFUSALS.filter((r) => found.has(r));
  if (refusals.length > 0) return { ok: false, category: refusals[0], refusals };
  return { ok: true, amountCents: amount as Cents, purpose, reasons };
}
