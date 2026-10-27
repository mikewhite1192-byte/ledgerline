// "Approve all clean" sends one batch id per confirmed list and total. Trying the same confirm
// again (an answer that never came back) keeps the id, so the server replays the batch rather than
// repeating it; a different list or total gets a new id, so a stored answer for one list is never
// read as the answer for another.

export type HeldBatch = { id: string; key: string };

export function batchKey(proposalIds: readonly string[], totalCents: number): string {
  return `${[...proposalIds].map((id) => id.toLowerCase()).sort().join(",")}|${totalCents}`;
}

export function batchFor(
  held: HeldBatch | null,
  proposalIds: readonly string[],
  totalCents: number,
  newId: () => string,
): HeldBatch {
  const key = batchKey(proposalIds, totalCents);
  return held && held.key === key ? held : { id: newId(), key };
}
