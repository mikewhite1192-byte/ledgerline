// What a driver's text or voice note says about a load, read by code. Pure. Muse Spark sorts the
// message as load_update; code then needs the whole load number in the text and a plain picked up
// or delivered, and anything less is a card for a person, never a guess.

const ALNUM = /[A-Za-z0-9]/;

function boundaryBefore(text: string, at: number): boolean {
  if (at === 0) return true;
  const prev = text[at - 1];
  if (ALNUM.test(prev)) return false;
  // "X-BR-L10247": a joiner with a letter or digit before it continues the number.
  if ((prev === "-" || prev === "/") && at >= 2 && ALNUM.test(text[at - 2])) return false;
  return true;
}

function boundaryAfter(text: string, end: number): boolean {
  if (end >= text.length) return true;
  const next = text[end];
  if (ALNUM.test(next)) return false;
  // "BR-L10247-2": a joiner with a letter or digit after it continues the number.
  if ((next === "-" || next === "/") && end + 1 < text.length && ALNUM.test(text[end + 1])) return false;
  return true;
}

// Whether the text holds the load number whole (case does not matter): never a part of a longer
// number, never a number with a part missing.
export function namesWhole(text: string, loadNumber: string): boolean {
  const n = loadNumber.trim();
  if (n.length < 3) return false;
  const hay = text.toUpperCase();
  const needle = n.toUpperCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    if (boundaryBefore(hay, at) && boundaryAfter(hay, at + needle.length)) return true;
    from = at + 1;
  }
}

// Lower case with accents removed, so "entregué" reads as "entregue".
function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/’/g, "'");
}

const PICKED_UP = [
  /\bpicked up\b/,
  /\bpicked it up\b/,
  /\bpick ?up (is )?(done|complete|completed)\b/,
  /\b(got |all |i'm |im |we're |were )?loaded\b/,
  /\bcargad[oa]s?\b/,
  /\bya cargue\b/,
  /\brecogid[oa]\b/,
  /\brecogi\b/,
];

const DELIVERED = [
  /\bdelivered\b/,
  /\bdropped (it |the load )?off\b/,
  /\bunloaded\b/,
  /\bdelivery (is )?(done|complete|completed)\b/,
  /\bentregad[oa]s?\b/,
  /\bentregue\b/,
  /\bdescargad[oa]s?\b/,
];

// A word that can turn the sentence around ("not delivered yet", "no he entregado"): the message is
// then a card, never a move.
const TURNS = /\b(not|no|never|yet|cannot|can't|cant|won't|wont|didn't|didnt|haven't|havent|hasn't|hasnt|isn't|isnt|aren't|arent|todavia|aun|nunca|tomorrow|manana|later|will)\b/;

export type SaidMove = "in_transit" | "delivered";

// "in_transit" when the text plainly says picked up, "delivered" when it plainly says delivered,
// null for both, neither, or a word that could turn the sentence around.
export function directionOf(text: string): SaidMove | null {
  const t = plain(text);
  if (TURNS.test(t)) return null;
  const up = PICKED_UP.some((r) => r.test(t));
  const down = DELIVERED.some((r) => r.test(t));
  if (up === down) return null;
  return up ? "in_transit" : "delivered";
}
