// Timestamps leave the database as ISO 8601 UTC text with a Z, the same on both drivers: the
// Data API would otherwise send a zoneless string that a reader could take as local time.
export const iso = (col: string, as?: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${as ?? col.replace(/^\w+\./, "")}`;
