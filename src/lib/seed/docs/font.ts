// A 5 x 7 dot font for the SAMPLE stamp and the composed fallback receipt. The text is drawn as
// square dots by our own code, not through a system font, so the same string renders the same
// pixels on any machine and a test can read every dot back. Upper case, digits and the
// punctuation a receipt prints; anything else is refused.

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
// One blank column between characters.
export const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

const GLYPHS: Record<string, readonly string[]> = {
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["###..", "#..#.", "#...#", "#...#", "#...#", "#..#.", "###.."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", "#...#", ".#.#.", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  $: ["..#..", ".####", "#.#..", ".###.", "..#.#", "####.", "..#.."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "/": [".....", "....#", "...#.", "..#..", ".#...", "#....", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "#": [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#."],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
};

// The dot rows of one character, upper-cased first.
export function glyph(ch: string): readonly string[] {
  const rows = GLYPHS[ch.toUpperCase()];
  if (!rows) throw new Error(`no glyph for ${JSON.stringify(ch)}`);
  return rows;
}

// Width in dots of a line of text.
export function textWidth(text: string): number {
  return text.length === 0 ? 0 : text.length * GLYPH_ADVANCE - 1;
}

// Every lit dot of a line as [column, row], from the line's top-left corner.
export function dots(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  [...text].forEach((ch, i) => {
    glyph(ch).forEach((row, y) => {
      for (let x = 0; x < GLYPH_WIDTH; x++) {
        if (row[x] === "#") out.push([i * GLYPH_ADVANCE + x, y]);
      }
    });
  });
  return out;
}

// An RGBA pixel buffer the caller owns.
export type Rgba = { data: Buffer; width: number; height: number };

// Paints a line of text into an RGBA buffer at (left, top), each dot a scale x scale square of
// the given color. Dots outside the buffer are refused rather than clipped.
export function paintText(
  img: Rgba,
  text: string,
  left: number,
  top: number,
  scale: number,
  color: readonly [number, number, number, number],
): void {
  if (
    !Number.isInteger(left) ||
    !Number.isInteger(top) ||
    !Number.isInteger(scale) ||
    scale < 1 ||
    left < 0 ||
    top < 0 ||
    left + textWidth(text) * scale > img.width ||
    top + GLYPH_HEIGHT * scale > img.height
  ) {
    throw new Error("text does not fit");
  }
  for (const [dx, dy] of dots(text)) {
    for (let y = 0; y < scale; y++) {
      for (let x = 0; x < scale; x++) {
        const at = ((top + dy * scale + y) * img.width + left + dx * scale + x) * 4;
        img.data[at] = color[0];
        img.data[at + 1] = color[1];
        img.data[at + 2] = color[2];
        img.data[at + 3] = color[3];
      }
    }
  }
}
