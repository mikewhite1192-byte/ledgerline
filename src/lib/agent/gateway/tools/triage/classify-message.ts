import { z } from "zod";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";

// Pure: records the triage model's classification as a validated decision. No row is read or
// written by the tool itself (the ref check confirms the ids exist).

export const MESSAGE_CATEGORIES = [
  "advance_request",
  "pay_question",
  "detention",
  "time_off",
  "address_change",
  "rate_confirmation",
  "other",
] as const;

export const classifyMessage = defineTool({
  name: "classify_message",
  description:
    "Classify one screened outside message: its category, how urgent it is, and the driver it " +
    "is from when known.",
  tier: "read",
  roles: ["triage"],
  label: "Sorting the message",
  args: z.strictObject({
    inputId: idField(),
    category: z.enum(MESSAGE_CATEGORIES),
    urgency: z.enum(["low", "normal", "high"]),
    driverId: idField().optional(),
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
    },
  }),
});
