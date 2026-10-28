import type { BriefFigure, FigureSource } from "../rules-engine";
import { checkBriefText } from "./verify";

// A checked brief as the page shows it: each tagged number becomes a link to where it came from,
// and the tags themselves are not shown. A tag with no number before it reads "(source)".

export type BriefPiece = { text: string; href: string | null; label?: string };

// Where a figure's source lives, or null when it has no page to open (the caller decides, for
// example a report while reports are switched off).
export type FigureHref = (source: FigureSource) => string | null;

const TAG_TEXT = /\s?\[f\d{1,4}\]/g;

// The words with the tags taken out, for a reader with no links (the agent's read tool).
export function briefPlainText(text: string): string {
  return text.replace(TAG_TEXT, "");
}

export function briefLinks(text: string, figures: readonly BriefFigure[], hrefFor: FigureHref): BriefPiece[] {
  const checked = checkBriefText(text, figures);
  // A stored brief passed this check when it was written; if the figures no longer read it the
  // same way, it is shown as plain words rather than with links that could point wrong.
  if (!checked.ok) return [{ text: briefPlainText(text), href: null }];
  const byKey = new Map(figures.map((f) => [f.key, f]));
  const linkOf = (key: string) => {
    const figure = byKey.get(key);
    return figure ? { href: hrefFor(figure.source), label: figure.label } : { href: null };
  };
  const out: BriefPiece[] = [];
  const plain = (s: string) => {
    if (s) out.push({ text: s, href: null });
  };
  const spanAt = new Map(checked.spans.map((s) => [s.tagStart, s]));
  let at = 0;
  for (const tag of checked.tags) {
    const span = spanAt.get(tag.start);
    if (span) {
      plain(checked.text.slice(at, span.start));
      out.push({ text: checked.text.slice(span.start, span.numberEnd), ...linkOf(span.key) });
      plain(checked.text.slice(span.numberEnd, span.tagStart).trimEnd());
    } else {
      plain(`${checked.text.slice(at, tag.start).trimEnd()} `);
      out.push({ text: "(source)", ...linkOf(tag.key) });
    }
    at = tag.end;
  }
  plain(checked.text.slice(at));
  return out;
}
