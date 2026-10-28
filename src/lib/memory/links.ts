// Where a note lives on the Memory page: each row carries this anchor, so a trace line can link
// straight to the note it names. Pure, so the browser's trace view can use it.
export function noteAnchor(id: string): string {
  return `note-${id}`;
}

export function noteHref(id: string): string {
  return `/memory#${noteAnchor(encodeURIComponent(id))}`;
}

// The table name a trace ref carries for a note. Not a record table: it links to Memory, never to
// /records.
export const NOTE_REF_TABLE = "carrier_notes";
