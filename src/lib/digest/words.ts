import { formatCents } from "../format/money";
import { NOT_READ, type DigestFact, type FactId } from "./facts";

// The morning digest as code writes it, from the same facts the model is given: what lands when
// the model fails or a number it wrote is refused. Pure. A fact that could not be read says "not
// read", never 0. At most 400 characters (agent_asks.text): sentences are kept in order of what
// matters most, and a sentence that does not fit is left out whole, never cut.

export const DIGEST_TEXT_MAX = 400;

type Facts = ReadonlyMap<FactId, DigestFact>;

const byId = (facts: readonly DigestFact[]): Facts => new Map(facts.map((f) => [f.id, f]));

// "2 card breaks", "1 card break", "card breaks not read".
function counted(facts: Facts, id: FactId, one: string, many: string): string | null {
  const f = facts.get(id);
  if (!f) return null;
  if (!f.known || typeof f.value !== "number") return `${many} ${NOT_READ}`;
  return `${f.value} ${f.value === 1 ? one : many}`;
}

function amount(facts: Facts, id: FactId): string {
  const f = facts.get(id);
  if (!f || !f.known || typeof f.value !== "number") return NOT_READ;
  return formatCents(f.value);
}

function textOf(facts: Facts, id: FactId): string | null {
  const f = facts.get(id);
  if (!f) return null;
  return f.known && typeof f.value === "string" ? f.value : NOT_READ;
}

// A fact that needs a person goes in the first sentence when it is above zero or was not read.
function needs(facts: Facts, id: FactId, one: string, many: string): string | null {
  const f = facts.get(id);
  if (!f) return null;
  if (f.known && f.value === 0) return null;
  return counted(facts, id, one, many);
}

function list(parts: (string | null)[]): string {
  return parts.filter((p): p is string => p !== null).join(", ");
}

export function digestWords(facts: readonly DigestFact[]): string {
  const f = byId(facts);
  const parked = needs(f, "parked", "parked advance", "parked advances");
  const reasons = textOf(f, "parked_reasons");
  const needList = list([
    needs(f, "card_breaks", "card break", "card breaks"),
    needs(f, "rulings_waiting", "card load ruling", "card load rulings"),
    parked && reasons && reasons !== "none" && f.get("parked")?.known ? `${parked} (${reasons})` : parked,
    needs(f, "advance_cards", "advance card", "advance cards"),
    needs(f, "send", "invoice to send", "invoices to send"),
    needs(f, "fix", "load to fix", "loads to fix"),
    needs(f, "ledger_unknown", "ledger row unknown", "ledger rows unknown"),
    needs(f, "approval_breaks", "approval break", "approval breaks"),
  ]);
  const sentences: string[] = [`Morning digest. Needs you: ${needList || "nothing"}.`];
  const check = textOf(f, "card_check");
  if (check) sentences.push(`Card check: ${check}.`);
  sentences.push(
    `Yesterday: ${list([
      counted(f, "cancelled", "trip cancelled", "trips cancelled"),
      `${counted(f, "hand_loads", "hand load", "hand loads")} (${amount(f, "hand_load_cents")})`,
      `${counted(f, "advances_paid", "advance paid", "advances paid")} (${amount(f, "advances_paid_cents")})`,
    ])}.`,
  );
  const n = (id: FactId) => {
    const x = f.get(id);
    return x && x.known && typeof x.value === "number" ? String(x.value) : NOT_READ;
  };
  sentences.push(`Billing: SEND ${n("send")}, FIX ${n("fix")}, ADD ${n("add")}, FYI ${n("past_due")} past due (${amount(f, "past_due_cents")}).`);
  if (f.has("paystubs_paid")) {
    sentences.push(`This week: ${counted(f, "paystubs_paid", "paystub paid", "paystubs paid")} (${amount(f, "paystubs_net_cents")}).`);
  }
  if (f.has("month_invoices")) {
    sentences.push(
      `Last month: ${counted(f, "month_invoices", "invoice issued", "invoices issued")} (${amount(f, "month_invoice_cents")}), ${n("month_not_posted")} not posted.`,
    );
  }
  return fit(sentences);
}

// Whole sentences in order while they fit; the first always (its needs list is cut at a comma when
// it alone is too long).
function fit(sentences: readonly string[]): string {
  let out = sentences[0];
  if (out.length > DIGEST_TEXT_MAX) {
    const cut = out.slice(0, DIGEST_TEXT_MAX - 1);
    out = `${cut.slice(0, Math.max(cut.lastIndexOf(","), 1))}.`;
  }
  for (const s of sentences.slice(1)) {
    if (out.length + 1 + s.length <= DIGEST_TEXT_MAX) out = `${out} ${s}`;
  }
  return out;
}
