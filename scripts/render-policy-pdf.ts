import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import PDFDocument from "pdfkit";

// npm run policy:pdf
//
// Renders the sample pay policy for the onboarding demo from its tracked text,
// src/lib/seed/policy/harrow-flats-pay-policy.md, to public/samples/policy/, where the upload
// demo and a "try the sample" link read it with no build step. The text is the contract, not the
// bytes: "#" lines are headings and blank lines split paragraphs. Every page carries a SAMPLE
// header and a footer saying the carrier is invented. Built-in Helvetica, so no font files; the
// creation date is fixed, so the same text renders the same file.

const SOURCE = join(process.cwd(), "src", "lib", "seed", "policy", "harrow-flats-pay-policy.md");
const TARGET = join(process.cwd(), "public", "samples", "policy", "harrow-flats-pay-policy.pdf");
const HEADER = "SAMPLE";
const FOOTER =
  "Fictitious carrier created for a software demonstration. Not a real company or policy.";
const CREATED = new Date("2026-10-27T00:00:00Z");

type Block = { heading: boolean; text: string };

// Paragraphs are split by blank lines; the lines inside one are joined with a space.
function blocksOf(text: string): Block[] {
  return text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.split("\n").map((line) => line.trim()).join(" ").trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) =>
      chunk.startsWith("#")
        ? { heading: true, text: chunk.replace(/^#+\s*/, "") }
        : { heading: false, text: chunk },
    );
}

async function main(): Promise<void> {
  const blocks = blocksOf(readFileSync(SOURCE, "utf8"));
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    bufferPages: true,
    info: {
      Title: "Harrow Flats Trucking Driver Pay Policy (SAMPLE)",
      Subject: FOOTER,
      CreationDate: CREATED,
      ModDate: CREATED,
    },
  });
  mkdirSync(dirname(TARGET), { recursive: true });
  const out = createWriteStream(TARGET);
  const done = new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });
  doc.pipe(out);

  blocks.forEach((block, i) => {
    if (block.heading) {
      if (i > 0) doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(i === 0 ? 16 : 12);
      doc.text(block.text, { paragraphGap: 4 });
    } else {
      doc.font("Helvetica").fontSize(10.5).text(block.text, { lineGap: 2, paragraphGap: 6 });
    }
  });

  // The header and footer sit in the margins, so the bottom margin is lifted while they are
  // drawn; otherwise the footer would start a new page.
  const pages = doc.bufferedPageRange();
  for (let n = pages.start; n < pages.start + pages.count; n++) {
    doc.switchToPage(n);
    const { width, height, margins } = doc.page;
    const box = { width: width - margins.left - margins.right, align: "center" as const };
    const bottom = margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#b42318");
    doc.text(HEADER, margins.left, 36, { ...box, lineBreak: false });
    doc.font("Helvetica").fontSize(8).fillColor("#555555");
    doc.text(FOOTER, margins.left, height - 44, { ...box, lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  await done;
  console.log(`wrote ${TARGET} (${blocks.length} blocks, ${pages.count} pages)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
