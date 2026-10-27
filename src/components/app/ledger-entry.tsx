import { Money } from "@/components/app/money";
import { StatusBadge } from "@/components/app/status-badge";
import { codeToWords } from "@/lib/format/labels";

// One ledger row on a record page: what was attempted, where it stands, and when. The id anchor
// (#ledger-<action id>) is what a paystub's payout line links to. The outside record shows by its
// last four characters only, and a failure by its category in words, never upstream text.

export type LedgerEntryView = {
  id: string;
  kind: string;
  state: string;
  attempt: number;
  amountCents: number;
  failureCategory: string | null;
  outsideSystem: string | null;
  outsideTail: string | null;
  createdAt: string;
  settledAt: string | null;
};

const PAYOUT_KINDS = new Set(["advance_payout", "settlement_payout"]);

// A payout by the rail that carried it.
const PAYOUT_WORDS: Readonly<Record<string, string>> = {
  fuel_card_sim: "Fuel card load",
  stripe_test: "Bank transfer",
  mock: "Payout (mock)",
};

const KIND_WORDS: Readonly<Record<string, string>> = {
  advance_payout: "Payout",
  settlement_payout: "Payout",
  advance_expense: "QuickBooks post",
};

export function payoutWords(entry: Pick<LedgerEntryView, "kind" | "outsideSystem">): string {
  if (PAYOUT_KINDS.has(entry.kind) && entry.outsideSystem && Object.hasOwn(PAYOUT_WORDS, entry.outsideSystem)) {
    return PAYOUT_WORDS[entry.outsideSystem];
  }
  return Object.hasOwn(KIND_WORDS, entry.kind) ? KIND_WORDS[entry.kind] : codeToWords(entry.kind);
}

// A decline is the card provider's answer; every other category reads in its own words.
function failureWords(category: string): string {
  const words = codeToWords(category).toLowerCase();
  return category === "declined" ? `${words} by the card provider` : words;
}

export function LedgerEntryRow({
  entry,
  when,
}: {
  entry: LedgerEntryView;
  when: (iso: string | null) => string;
}) {
  return (
    <li id={`ledger-${entry.id}`} className="grid gap-1 rounded-lg border border-border px-4 py-3">
      <p className="flex flex-wrap items-center gap-2 text-body text-foreground">
        {payoutWords(entry)}, attempt {entry.attempt}
        <StatusBadge status={entry.state} />
        <Money cents={entry.amountCents} className="ml-auto" />
      </p>
      <p className="text-small text-muted-foreground">
        Reserved {when(entry.createdAt)}
        {entry.settledAt ? `, settled ${when(entry.settledAt)}` : ""}
        {entry.outsideTail ? `, outside id ending ${entry.outsideTail}` : ""}
        {entry.failureCategory ? `, ${failureWords(entry.failureCategory)}` : ""}
      </p>
    </li>
  );
}
