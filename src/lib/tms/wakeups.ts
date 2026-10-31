// TMS-MIRROR: the wake-up entry point's reader. A wake-up only says "read this record again";
// no payload is ever trusted for content. Exactly two fields are read, both bounded: the record
// type (one of three) and the external id (the id pattern the contract allows). Everything else
// in the payload is dropped unread. The table that queues wake-ups and the HTTP route that feeds
// it ship together later (0076, its own review); the synthetic feed sends none.

export const TMS_RECORD_TYPES = ["load", "driver", "customer"] as const;
export type TmsRecordType = (typeof TMS_RECORD_TYPES)[number];

export type WakeUp = { recordType: TmsRecordType; externalId: string };

const ID = /^[A-Za-z0-9:._-]{1,64}$/;

export function isTmsRecordType(value: unknown): value is TmsRecordType {
  return typeof value === "string" && (TMS_RECORD_TYPES as readonly string[]).includes(value);
}

// The wake-up a payload names, or null when either field is missing or out of bounds.
export function readWakeUp(payload: unknown): WakeUp | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const recordType = p.recordType;
  const externalId = p.externalId;
  if (!isTmsRecordType(recordType)) return null;
  if (typeof externalId !== "string" || !ID.test(externalId)) return null;
  return { recordType, externalId };
}
