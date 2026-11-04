// The answer as a person reads it (house style): no em or en dashes and dates as a month and day,
// applied by code to every answer the loop keeps, since the prompt alone did not hold
// (production answers wrote "2026-11-03" and dashes). It changes punctuation and dates only, never
// a figure or an id, plus two slips a rehearsal showed: "This weeks pay" for "This week's pay", and
// a table said to be "above" when the chat always shows a report's table below the answer.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A whole YYYY-MM-DD, never part of a longer run of digits, letters or dashes (an id).
const ISO_DATE = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g;
const DASH = /[\u2013\u2014]/;

function plainDate(match: string, y: string, m: string, d: string): string {
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return match;
  return `${MONTHS[month - 1]} ${day}, ${y}`;
}

// Code spans and web links are kept as written: no dash or date inside them is changed.
const KEPT = /(`[^`]*`|https?:\/\/[^\s`]+)/;

// "this weeks" is never a plural ("this" takes one week), so it is the possessive missing its
// apostrophe.
const THIS_WEEKS = /\b([Tt]his) weeks\b(?!['\u2019])/g;
// A table or report said to be above: "the table above", "the report shown above", "the above table".
const TABLE_ABOVE = /\b(tables?|report)((?:\s+(?:is|are|shown|listed))?)\s+above\b/gi;
const ABOVE_TABLE = /\b([Tt]he) above (tables?|report)\b/g;

function plainWords(part: string): string {
  return part
    .replace(THIS_WEEKS, "$1 week's")
    .replace(TABLE_ABOVE, "$1$2 below")
    .replace(ABOVE_TABLE, "$1 $2 below");
}

function plainProse(part: string, first: boolean, last: boolean): string {
  const dated = plainWords(part).replace(ISO_DATE, plainDate);
  if (!DASH.test(dated)) return dated;
  let out = dated
    // Written tight between two figures (10\u201320) it is a range.
    .replace(/(\d)[\u2013\u2014](?=\d|\$)/g, "$1 to ")
    // Directly before any other figure or "$" it is a minus sign.
    .replace(/[\u2013\u2014](?=[\d$])/g, "-");
  // A dash that starts a line is a list bullet.
  if (first) out = out.replace(/^(\s*)[\u2013\u2014]\s*/, "$1- ");
  // Anywhere else it is a pause.
  out = out.replace(/\s*[\u2013\u2014]+\s*/g, ", ").replace(/,\s*([,.;:!?])/g, "$1");
  return last ? out.replace(/,\s*$/, "") : out;
}

function plainLine(line: string): string {
  // Split on the kept spans: prose sits at even indexes, kept text at odd ones, prose last.
  const parts = line.split(KEPT);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : plainProse(part, i === 0, i === parts.length - 1)))
    .join("");
}

export function plainAnswer(text: string): string {
  return text.split("\n").map(plainLine).join("\n");
}
