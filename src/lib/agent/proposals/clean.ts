// "Clean" per proposal, so Approve all clean is a filter, not a schema change (design 2.7): still
// waiting, no exception from the engine or the gateway, no flagged input, and the auditor agrees.
// Gateway passed is implied by the row existing.

export type CleanFields = {
  status: string;
  exceptions: readonly unknown[];
  flaggedInputId: string | null;
  auditorAgrees: boolean | null;
};

export function isClean(p: CleanFields): boolean {
  return (
    p.status === "proposed" &&
    p.exceptions.length === 0 &&
    p.flaggedInputId === null &&
    p.auditorAgrees === true
  );
}

// The same test as a WHERE fragment over the proposals table (alias p), for list screens.
export const CLEAN_SQL =
  "p.status = 'proposed' AND jsonb_array_length(p.exceptions) = 0 " +
  "AND p.flagged_input_id IS NULL AND p.auditor_agrees IS TRUE";
