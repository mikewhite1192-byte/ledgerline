import type { CardText } from "@/lib/pay-cards/spec";

// Draws one pay card, 1080 by 1350, from the strings the server worked out (CardText) and nothing
// else: no number is formatted, added or rounded here, so every figure on the card is one the
// server wrote. The background picture fills the card and a white panel carries every word, so the
// read-back sees dark text on white whatever the picture.
//
// Self-contained on purpose (no imports at run time, helpers nested inside): the same function
// runs in the cards page, in a unit test with a recording context, and in a Playwright page from
// its own source text.

export type DrawContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "fillRect"
  | "fillText"
  | "measureText"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "arcTo"
  | "closePath"
  | "fill"
  | "stroke"
  | "drawImage"
> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

export type DrawArt = { image: CanvasImageSource; width: number; height: number } | null;

export function drawPayCard(ctx: DrawContext, text: CardText, art: DrawArt, fontFamily: string): void {
  const W = 1080;
  const H = 1350;
  const INK = "#161d1a";
  const MUTED = "#4a5651";
  const BRAND = "#0e6b4d";
  const PANEL = { x: 60, y: 60, w: 960, h: 1230, r: 48 };
  const LEFT = 132;
  const RIGHT = 948;
  const family = fontFamily && fontFamily.trim() ? fontFamily : "sans-serif";

  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // Writes one line at the largest size up to `size` that fits `maxWidth`, never below 60% of it.
  function line(
    value: string,
    x: number,
    y: number,
    size: number,
    weight: number,
    color: string,
    maxWidth: number,
    align: CanvasTextAlign = "left",
  ): number {
    let px = size;
    const min = Math.ceil(size * 0.6);
    ctx.font = `${weight} ${px}px ${family}`;
    while (px > min && ctx.measureText(value).width > maxWidth) {
      px = Math.max(min, px - 2);
      ctx.font = `${weight} ${px}px ${family}`;
    }
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(value, x, y, maxWidth);
    return px;
  }

  function rule(y: number): void {
    ctx.strokeStyle = "#dfe5e2";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(LEFT, y);
    ctx.lineTo(RIGHT, y);
    ctx.stroke();
  }

  ctx.save();
  ctx.textBaseline = "alphabetic";

  // The background: the picture, cropped to fill, or plain brand green when there is none. Plain,
  // not a gradient: a browser dithers a gradient, and the noise alone takes the file past the
  // check's size cap.
  if (art && art.width > 0 && art.height > 0) {
    const scale = Math.max(W / art.width, H / art.height);
    const w = art.width * scale;
    const h = art.height * scale;
    ctx.drawImage(art.image, (W - w) / 2, (H - h) / 2, w, h);
  } else {
    ctx.fillStyle = BRAND;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.fillStyle = "#ffffff";
  roundRect(PANEL.x, PANEL.y, PANEL.w, PANEL.h, PANEL.r);
  ctx.fill();

  const width = RIGHT - LEFT;
  // Header: the carrier on the left, the card's name on the right.
  line(text.carrier, LEFT, 160, 34, 600, MUTED, width * 0.6);
  line(text.title, RIGHT, 160, 34, 700, BRAND, width * 0.36, "right");

  line(text.name, LEFT, 290, 84, 700, INK, width);
  line(text.week, LEFT, 350, 38, 500, MUTED, width);
  rule(400);

  line(text.netLabel, LEFT, 480, 40, 600, MUTED, width);
  line(text.net, LEFT, 610, 136, 800, BRAND, width);

  line(text.earned, LEFT, 710, 46, 600, INK, width);
  line(text.takenOut, LEFT, 780, 46, 600, INK, width);
  line(text.work, LEFT, 850, 40, 500, MUTED, width);
  rule(900);

  line(text.change, LEFT, 980, 44, 700, INK, width);
  let y = 1045;
  if (text.topChange) {
    line(text.topChange, LEFT, y, 36, 500, MUTED, width);
    y += 60;
  }
  if (text.carried) {
    line(text.carried, LEFT, y, 36, 600, INK, width);
  }

  // Footer: the pay status, and the test-mode tag on the right.
  line(text.status, LEFT, 1215, 38, 700, INK, width * 0.6);
  ctx.font = `700 30px ${family}`;
  const tagWidth = Math.min(ctx.measureText(text.testMode).width + 48, width * 0.38);
  ctx.fillStyle = "#dcefe5";
  roundRect(RIGHT - tagWidth, 1170, tagWidth, 62, 31);
  ctx.fill();
  line(text.testMode, RIGHT - tagWidth / 2, 1212, 30, 700, BRAND, tagWidth - 32, "center");

  ctx.restore();
}
