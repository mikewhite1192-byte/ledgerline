// The answer as a person reads it (house style): no em or en dashes and dates as a month and day,
// applied by code to every answer the loop keeps, since the prompt alone did not hold
// (production answers wrote "2026-11-03" and dashes). It changes punctuation and dates only, never
// a figure or an id.

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

function plainLine(line: string): string {
  if (!DASH.test(line)) return line;
  return (
    line
      // A dash that starts a line is a list bullet.
      .replace(/^(\s*)[\u2013\u2014]\s*/, "$1- ")
      // Written tight between two figures (10\u201320) it is a range.
      .replace(/(\d)[\u2013\u2014](?=\d|\$)/g, "$1 to ")
      // Anywhere else it is a pause.
      .replace(/\s*[\u2013\u2014]+\s*/g, ", ")
      .replace(/,\s*([,.;:!?])/g, "$1")
      .replace(/,\s*$/, "")
  );
}

export function plainAnswer(text: string): string {
  return text.split("\n").map(plainLine).join("\n").replace(ISO_DATE, plainDate);
}
