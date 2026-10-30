import { z } from "zod";
import { isLocalDate } from "../time/local-date";

// What a load_create proposal stores as its args: the ids it was made from (the load's reserved
// id, the document, the transcript and the reading's hash), then the load exactly as the checks
// in check.ts worked it out. Every value is an id, a code, a date, a count or whole cents; the
// customer is the tenant's own row, found by whole value, never a name the model wrote. The
// charge lines carry only their kind and amount: the model's own words for a line never reach a
// record, a card or an invoice. The executor parses the stored args with this schema and checks
// them again against the stored reading before it writes anything.

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const DATE = z.string().refine(isLocalDate);
const CENTS = z.number().int().min(0).max(999_999_999);
const POSITIVE_CENTS = z.number().int().min(1).max(999_999_999);

export const LOAD_NUMBER = /^[A-Z0-9-]{2,40}$/;
export const CITY = /^[A-Za-z][A-Za-z .'-]{0,79}$/;
export const STATE = /^[A-Z]{2}$/;
export const DRIVER_CODE = /^[A-Z0-9-]{1,20}$/;
export const LOAD_ACCESSORIAL_KINDS = ["detention", "layover", "stop", "lumper"] as const;
export type LoadAccessorialKind = (typeof LOAD_ACCESSORIAL_KINDS)[number];

export const loadCreateArgsSchema = z.strictObject({
  v: z.literal(1),
  loadId: UUID,
  documentId: UUID,
  inputId: UUID,
  // sha256 of the stored transcript (untrustedContentHash("document", body)).
  readingHash: z.string().regex(/^[0-9a-f]{64}$/),
  loadNumber: z.string().regex(LOAD_NUMBER),
  customerId: UUID,
  // The customer row's own code (0004: ^[A-Z0-9-]{2,20}$), never the printed one.
  customerCode: z.string().regex(/^[A-Z0-9-]{2,20}$/),
  originCity: z.string().regex(CITY),
  originState: z.string().regex(STATE),
  destCity: z.string().regex(CITY),
  destState: z.string().regex(STATE),
  pickupOn: DATE,
  deliveryOn: DATE.nullable(),
  loadedMiles: z.number().int().min(1).max(9_999),
  ratePerMileCents: POSITIVE_CENTS.nullable(),
  linehaulCents: POSITIVE_CENTS,
  fuelSurchargeCents: CENTS,
  accessorials: z.array(z.strictObject({ kind: z.enum(LOAD_ACCESSORIAL_KINDS), amountCents: POSITIVE_CENTS })).max(6),
  totalCents: POSITIVE_CENTS,
  driverCodeClaim: z.string().regex(DRIVER_CODE).nullable(),
  // Set by persistEngineProposal: the subject's earlier cards that ended expired or failed.
  revision: z.number().int().min(0).max(1_000).optional(),
});

export type LoadCreateArgs = z.infer<typeof loadCreateArgsSchema>;

export function parseLoadCreateArgs(raw: unknown): LoadCreateArgs | null {
  const parsed = loadCreateArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
