import { z } from "zod";
import { defineTool, type GatewayRef } from "../../types";
import { dateField, idField } from "../../validate";

// Pure: records the triage model's classification as a validated decision. No row is read or
// written by the tool itself (the ref check confirms the ids exist). The amount and the dates are
// what the message says, read by a model: a hint for the person and the agent, never a number
// anything pays or books.

// Under $1,000,000, the same bound as inbound_messages.triage_amount_cents (0037).
export const MAX_TRIAGE_AMOUNT_CENTS = 99_999_999;
export const MAX_TRIAGE_DATES = 3;

export const MESSAGE_CATEGORIES = [
  "advance_request",
  "pay_question",
  "detention",
  "time_off",
  "address_change",
  "rate_confirmation",
  // A driver saying a load was picked up or delivered. Code then checks the whole load number and
  // the sender before any move (src/lib/loads/movement.ts); this category alone moves nothing.
  "load_update",
  "other",
] as const;

export const classifyMessage = defineTool({
  name: "classify_message",
  description:
    "Classify one screened outside message: its category, how urgent it is, the driver it is " +
    "from when known, and the dollar amount (in cents) and dates (YYYY-MM-DD) it names, if any.",
  tier: "read",
  roles: ["triage"],
  label: "Sorting the message",
  args: z.strictObject({
    inputId: idField(),
    category: z.enum(MESSAGE_CATEGORIES),
    urgency: z.enum(["low", "normal", "high"]),
    driverId: idField().optional(),
    amountCents: z.number().int().min(0).max(MAX_TRIAGE_AMOUNT_CENTS).optional(),
    dates: z.array(dateField()).max(MAX_TRIAGE_DATES).optional(),
  }),
  refs: (a): GatewayRef[] => [
    { table: "untrusted_inputs", id: a.inputId },
    ...(a.driverId ? [{ table: "drivers" as const, id: a.driverId }] : []),
  ],
  run: async (_q, _ctx, a) => ({
    result: {
      inputId: a.inputId,
      category: a.category,
      urgency: a.urgency,
      driverId: a.driverId ?? null,
      amountCents: a.amountCents ?? null,
      dates: a.dates ?? [],
    },
  }),
});
