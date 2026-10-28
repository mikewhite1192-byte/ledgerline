import type { CarrierNoteRow, CustomerRow, DriverRow } from "../data/rows";
import { compareText } from "../rules-engine";
import type { LocalDate } from "../time/local-date";
import { customerClassOf } from "./ar-plan";
import { Rng } from "./prng";

// The sample notes each demo carrier starts with (CARRIER-MEMORY): four active notes the office
// "wrote", so the Memory page and the agent's notes section have something real to show. Plain
// words and no figures that could be read as an amount. Two are about the slow-paying customers
// the receivables plan already makes (indexes 2 and 5), one about the first driver whose pay notes
// are in Spanish, and one about the carrier as a whole. The ids come from their own random stream
// (`<slug>:<anchor>:memory`), so adding these rows changes no other row of the plan.

export const SLOW_PAYER_NOTE = "Pays about 45 days after due; send reminders early";
export const DRIVER_NOTE = "Prefers texts in Spanish; asks for advances on Thursdays";
export const CARRIER_NOTE = "Owner wants every detention charge billed the same week";

const SLOW_INDEXES = [2, 5] as const;

export function buildCarrierNotes(input: {
  slug: string;
  anchor: LocalDate;
  customers: readonly CustomerRow[];
  drivers: readonly DriverRow[];
}): CarrierNoteRow[] {
  const rng = new Rng(`${input.slug}:${input.anchor}:memory`);
  const note = (
    subject_kind: CarrierNoteRow["subject_kind"],
    subject_id: string | null,
    text: string,
  ): CarrierNoteRow => ({
    id: rng.uuid(),
    subject_kind,
    subject_id,
    text,
    status: "active",
    source_kind: "seed",
    source_turn_id: null,
    source_table: null,
    source_id: null,
    created_by_kind: "seed",
    created_by_sub: null,
    created_by_model_call_id: null,
    updated_by_sub: null,
  });

  const out: CarrierNoteRow[] = [];
  for (const index of SLOW_INDEXES) {
    const customer = input.customers[index];
    if (!customer) throw new Error("the memory plan needs the slow-paying customers");
    if (customerClassOf(index) !== "slow") throw new Error("the memory plan's customer is not a slow payer");
    out.push(note("customer", customer.id, SLOW_PAYER_NOTE));
  }
  const spanish = [...input.drivers]
    .filter((d) => d.preferred_language === "es")
    .sort((a, b) => compareText(a.code, b.code))[0];
  if (!spanish) throw new Error("the memory plan needs a driver whose notes are in Spanish");
  out.push(note("driver", spanish.id, DRIVER_NOTE));
  out.push(note("carrier", null, CARRIER_NOTE));
  return out;
}
