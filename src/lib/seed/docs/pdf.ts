import PDFDocument from "pdfkit";
import { pdfContent, type PdfContent } from "./documents";
import { PDF_FOOTER, type PdfDoc } from "./manifest";

// Renders a rate confirmation or bill of lading to PDF bytes from its manifest entry. Pure: the
// same entry gives the same bytes (fixed dates, built-in Helvetica, no compression, so no zlib
// build difference between machines can change a byte), which pdf.test.ts checks against the
// committed file. Every page carries the red SAMPLE header and the fictitious-carrier footer,
// as the sample pay policy does.

const HEADER = "SAMPLE";
const CREATED = new Date("2026-10-27T00:00:00Z");
const RED = "#b42318";
const INK = "#1a1a1a";
const MUTED = "#555555";
const RULE = "#c8c8c8";

const LEFT = 72;
const VALUE_X = 190;

function draw(doc: PDFKit.PDFDocument, content: PdfContent): void {
  const right = doc.page.width - LEFT;
  const width = right - LEFT;
  let y = 84;

  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK);
  doc.text(content.title, LEFT, y, { lineBreak: false });
  y += 34;
  doc.moveTo(LEFT, y).lineTo(right, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 14;

  for (const f of content.fields) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(MUTED);
    doc.text(f.label, LEFT, y, { lineBreak: false });
    doc.font("Helvetica").fontSize(11).fillColor(INK);
    doc.text(f.value, VALUE_X, y - 1, { lineBreak: false });
    y += 20;
  }

  if (content.charges.length > 0) {
    y += 12;
    doc.font("Helvetica-Bold").fontSize(12).fillColor(INK);
    doc.text("Charges", LEFT, y, { lineBreak: false });
    y += 22;
    content.charges.forEach((c, i) => {
      const last = i === content.charges.length - 1;
      if (last) {
        doc.moveTo(LEFT, y - 6).lineTo(right, y - 6).lineWidth(1).strokeColor(RULE).stroke();
      }
      doc.font(last ? "Helvetica-Bold" : "Helvetica").fontSize(11).fillColor(INK);
      doc.text(c.label, LEFT, y, { lineBreak: false });
      doc.text(c.value, LEFT, y, { width, align: "right", lineBreak: false });
      y += 22;
    });
  }

  if (content.stops.length > 0) {
    y += 12;
    doc.font("Helvetica-Bold").fontSize(12).fillColor(INK);
    doc.text("Stops", LEFT, y, { lineBreak: false });
    y += 22;
    const gap = 12;
    const boxW = (width - gap) / 2;
    const boxH = 46;
    content.stops.forEach((s, i) => {
      const x = LEFT + (i % 2) * (boxW + gap);
      const top = y + Math.floor(i / 2) * (boxH + gap);
      doc.rect(x, top, boxW, boxH).lineWidth(1).strokeColor(RULE).stroke();
      doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED);
      doc.text(s.label, x + 10, top + 9, { lineBreak: false });
      doc.font("Helvetica").fontSize(12).fillColor(INK);
      doc.text(s.value, x + 10, top + 24, { lineBreak: false });
    });
    y += 2 * boxH + gap;
  }

  y += 44;
  const sigW = (width - 24 * (content.signatures.length - 1)) / content.signatures.length;
  content.signatures.forEach((label, i) => {
    const x = LEFT + i * (sigW + 24);
    doc.moveTo(x, y).lineTo(x + sigW, y).lineWidth(0.75).strokeColor(INK).stroke();
    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    doc.text(label, x, y + 6, { lineBreak: false });
  });
}

export async function renderPdf(entry: PdfDoc): Promise<Buffer> {
  const content = pdfContent(entry);
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 72, bottom: 72, left: LEFT, right: LEFT },
    bufferPages: true,
    compress: false,
    info: {
      Title: `${content.title} ${entry.expect.loadNumber} (SAMPLE)`,
      Subject: PDF_FOOTER,
      CreationDate: CREATED,
      ModDate: CREATED,
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  draw(doc, content);

  // The header and footer sit in the margins, so the bottom margin is lifted while they are
  // drawn; otherwise the footer would start a new page.
  const pages = doc.bufferedPageRange();
  for (let n = pages.start; n < pages.start + pages.count; n++) {
    doc.switchToPage(n);
    const { width, height, margins } = doc.page;
    const box = { width: width - margins.left - margins.right, align: "center" as const };
    const bottom = margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica-Bold").fontSize(14).fillColor(RED);
    doc.text(HEADER, margins.left, 36, { ...box, lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor(MUTED);
    doc.text(PDF_FOOTER, margins.left, height - 44, { ...box, lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}

// Pages in a PDF, counted from its page objects.
export function pdfPageCount(bytes: Buffer): number {
  return (bytes.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

// The body of indirect object `num 0 obj ... endobj`, trimmed, or undefined.
function objectBody(text: string, num: string): string | undefined {
  const marker = `\n${num} 0 obj`;
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  const start = at + marker.length;
  const end = text.indexOf("endobj", start);
  return end < 0 ? undefined : text.slice(start, end).trim();
}

// The info dictionary's Subject, as pdfkit writes it uncompressed: an indirect object holding a
// literal string or, for non-ASCII text, a hex string. Null when absent.
export function pdfSubject(bytes: Buffer): string | null {
  const text = bytes.toString("latin1");
  const ref = /\/Subject\s+(\d+)\s+0\s+R/.exec(text);
  const value = ref
    ? objectBody(text, ref[1])
    : /\/Subject\s*(\([^\n]*\)|<[0-9A-Fa-f]*>)/.exec(text)?.[1];
  if (!value) return null;
  const literal = /^\(((?:\\.|[^\\)])*)\)$/.exec(value);
  if (literal) return literal[1].replace(/\\(.)/g, "$1");
  const hex = /^<([0-9A-Fa-f]+)>$/.exec(value);
  if (!hex) return null;
  const raw = Buffer.from(hex[1], "hex");
  // UTF-16BE with a byte order mark.
  if (raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.from(raw.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return raw.toString("latin1");
}
