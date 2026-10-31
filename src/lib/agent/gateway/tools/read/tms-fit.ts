// The dispatch tools fit their own results under the gateway's cap (MAX_RESULT_CHARS, 8,000
// characters of JSON), so a long list loses rows from its end and says how many, instead of the
// whole result turning into a "too large" note. Lists are cut in the order given, one row at a time.

export const TMS_RESULT_ROOM = 7_900;

export type FitList = { rows: unknown[]; total: number; omitted: number };

const size = (v: unknown) => JSON.stringify(v).length;

// Cuts the named lists of result in place until it fits room, first list first. Each list's
// omitted is its total less the rows kept. Returns the result, which may still be over room only
// when every list is empty.
export function fitTmsResult<T extends Record<string, unknown>>(
  result: T,
  lists: readonly FitList[],
  room: number = TMS_RESULT_ROOM,
): T {
  for (const l of lists) l.omitted = Math.max(0, l.total - l.rows.length);
  for (const l of lists) {
    while (l.rows.length > 0 && size(result) > room) {
      l.rows.pop();
      l.omitted = Math.max(0, l.total - l.rows.length);
    }
    if (size(result) <= room) break;
  }
  return result;
}
