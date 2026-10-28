// Grounding a rate lookup (GROUNDED-RATES design 4.2, adapted to what the API returns). The model's
// sentence is never the rate. It names a figure; our code takes that figure only when the same
// digits appear whole in the title or snippet of a page the search itself returned (the wrapper's
// searchResults, never a page the model only typed). Measured on Muse Spark on Oct 27, 2026: the
// answer's url_citation annotations came back empty and every result snippet was "", so a figure
// can be matched in a result's title, and the cited set is the annotations plus any address the
// answer text names that equals a returned result's address as a whole string. Anything short of a
// match is "unconfirmed" (a returned page to open, no figure) or a failure with a category; it is
// never a rate.

export const RATE_KINDS = ["diesel_index", "ifta_rate"] as const;
export type RateKind = (typeof RATE_KINDS)[number];

export type GroundFailure = "no_source" | "no_figure" | "not_matched";

export type Grounded =
  | {
      status: "suggested";
      valueMcents: number;
      sourceUrl: string;
      sourceTitle: string | null;
      quote: string;
      asOf: string | null;
    }
  | { status: "unconfirmed"; sourceUrl: string; sourceTitle: string | null }
  | { status: "failed"; category: GroundFailure };

// A figure in dollars per gallon, whole: 1 or 2 digits, a point and 3 or 4 decimals, with no digit
// or point-digit on either side ("3.657" is not inside "13.6571" or "3.6571").
const FIGURE = /(?<![\d.])\d{1,2}\.\d{3,4}(?![\d]|\.\d)/g;

// Thousandths of a cent per gallon a figure may be, per kind: a diesel price from $1 to $20, a
// state's fuel tax rate above zero and at most $2. Anything else is not this kind of rate.
const RANGE: Readonly<Record<RateKind, { min: number; max: number }>> = {
  diesel_index: { min: 100_000, max: 2_000_000 },
  ifta_rate: { min: 1, max: 200_000 },
};

export const MAX_URL = 2000;
export const MAX_TITLE = 200;
export const MAX_QUOTE = 300;

// "6.352" is 635,200 and "0.2850" is 28,500 thousandths of a cent: the digits as a whole number,
// scaled by the decimals. Integers only.
export function figureToMcents(figure: string): number | null {
  const m = /^(\d{1,2})\.(\d{3,4})$/.exec(figure);
  if (!m) return null;
  const digits = Number(`${m[1]}${m[2]}`);
  return digits * 10 ** (5 - m[2].length);
}

export function isPlausible(kind: RateKind, mcents: number): boolean {
  const r = RANGE[kind];
  return Number.isSafeInteger(mcents) && mcents >= r.min && mcents <= r.max;
}

// An https address of at most MAX_URL characters, kept exactly as written; anything else is null.
export function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL) return null;
  if (!raw.startsWith("https://")) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

// Whitespace and control characters folded to single spaces.
function clean(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True when the exact figure appears whole in the text.
export function containsWhole(text: string, figure: string): boolean {
  return wholeAt(text, figure) >= 0;
}

function wholeAt(text: string, figure: string): number {
  for (const m of text.matchAll(FIGURE)) {
    if (m[0] === figure) return m.index;
  }
  return -1;
}

// The first figure the answer states, if it is a plausible rate of this kind. Only the first: a
// later number is never tried in its place.
export function statedFigure(kind: RateKind, answerText: string): string | null {
  const m = answerText.matchAll(FIGURE).next().value;
  if (!m) return null;
  const mcents = figureToMcents(m[0]);
  return mcents !== null && isPlausible(kind, mcents) ? m[0] : null;
}

// Every https address in the answer text, trailing punctuation removed.
export function urlsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https:\/\/[^\s<>"'`)\]]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (httpsUrl(url)) out.push(url);
  }
  return out;
}

// At most MAX_QUOTE characters of the text the figure was matched in, around the figure.
export function quoteAround(text: string, figure: string): string {
  const at = wholeAt(text, figure);
  if (text.length <= MAX_QUOTE || at < 0) return text.slice(0, MAX_QUOTE);
  const start = Math.max(0, Math.min(at - Math.floor((MAX_QUOTE - figure.length) / 2), text.length - MAX_QUOTE));
  return text.slice(start, start + MAX_QUOTE);
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12,
};

function realDate(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// A full date in the quote ("October 26, 2026", "Oct. 26, 2026" or "2026-10-26"), else null. A
// date without its year is never guessed.
export function dateIn(text: string): string | null {
  const iso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(text);
  if (iso) {
    const d = realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (d) return d;
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})\b/g)) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) continue;
    const d = realDate(Number(m[3]), month, Number(m[2]));
    if (d) return d;
  }
  return null;
}

type Page = { url: string; title: string; snippet: string };

// The wrapper's web answer (AiWebAnswer in src/lib/ai), by shape: only lookup.ts names the wrapper.
export type WebAnswer = {
  answerText: string;
  citations: readonly { url: string }[];
  searchResults: readonly Page[];
};

// The returned results with an https address, each address once (its first entry).
function pagesOf(results: readonly Page[]): Page[] {
  const seen = new Set<string>();
  const out: Page[] = [];
  for (const r of results) {
    const url = httpsUrl(r.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: clean(r.title ?? ""), snippet: clean(r.snippet ?? "") });
  }
  return out;
}

function titleOf(page: Page): string | null {
  return page.title === "" ? null : page.title.slice(0, MAX_TITLE);
}

export function groundAnswer(kind: RateKind, web: WebAnswer): Grounded {
  const pages = pagesOf(web.searchResults);
  if (pages.length === 0) return { status: "failed", category: "no_source" };
  const returned = new Set(pages.map((p) => p.url));
  const cited = new Set(
    [...web.citations.map((c) => c.url), ...urlsInText(web.answerText)].filter((u) => returned.has(u)),
  );

  const figure = statedFigure(kind, web.answerText);
  if (figure !== null) {
    const matches = pages.filter((p) => containsWhole(p.snippet, figure) || containsWhole(p.title, figure));
    const page = matches.find((p) => cited.has(p.url)) ?? matches[0];
    if (page) {
      const text = containsWhole(page.snippet, figure) ? page.snippet : page.title;
      const quote = quoteAround(text, figure);
      const valueMcents = figureToMcents(figure);
      if (valueMcents !== null) {
        return {
          status: "suggested",
          valueMcents,
          sourceUrl: page.url,
          sourceTitle: titleOf(page),
          quote,
          asOf: dateIn(quote),
        };
      }
    }
  }
  const source = pages.find((p) => cited.has(p.url));
  if (source) return { status: "unconfirmed", sourceUrl: source.url, sourceTitle: titleOf(source) };
  return { status: "failed", category: figure === null ? "no_figure" : "not_matched" };
}
