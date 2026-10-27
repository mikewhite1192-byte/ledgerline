import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pdfContent, textRuns } from "./documents";
import { PDF_FOOTER, SAMPLE_DOCS, isPdf, type PdfDoc, type RateConDoc } from "./manifest";
import { pdfPageCount, pdfSubject, renderPdf } from "./pdf";

// The committed PDFs came from these numbers: each is rendered again from its manifest entry and
// must equal the committed file byte for byte.

const PDFS = SAMPLE_DOCS.filter(isPdf);
const PUBLIC = join(process.cwd(), "public");

// The strings each page's content stream draws, read from the rendered bytes (textRuns reads the
// content model, which leaves the header and footer out). Uncompressed, pdfkit writes built-in
// font text as hex strings of character codes in TJ arrays, with kerning numbers between the
// pieces of one string; ASCII text keeps its ASCII codes. Anything else here throws.
function drawnRuns(bytes: Buffer): string[][] {
  const text = bytes.toString("latin1");
  const objects = new Map<string, string>();
  for (const m of text.matchAll(/\n(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) objects.set(m[1], m[2]);
  return [...objects.values()]
    .filter((body) => /\/Type\s*\/Page(?!s)/.test(body))
    .map((page) => {
      const ref = /\/Contents\s+(\d+)\s+0\s+R/.exec(page);
      const body = ref ? objects.get(ref[1]) : undefined;
      const head = body ? /^<<([\s\S]*?)>>\nstream\r?\n/.exec(body) : null;
      if (!body || !head) throw new Error("a page without a content stream");
      if (head[1].includes("/Filter")) throw new Error("a compressed content stream");
      const start = head[0].length;
      const end = start + Number(/\/Length\s+(\d+)/.exec(head[1])?.[1]);
      if (!/^\r?\n?endstream$/.test(body.slice(end))) throw new Error("a stream length that does not fit");
      return [...body.slice(start, end).matchAll(/\[([^\]]*)\]\s*TJ/g)].map((tj) => {
        let run = "";
        for (const piece of tj[1].matchAll(/<([0-9A-Fa-f]*)>|(-?[\d.]+)|(\S+)/g)) {
          if (piece[3] !== undefined) throw new Error("a TJ piece this reader does not decode");
          if (piece[1] !== undefined) run += Buffer.from(piece[1], "hex").toString("latin1");
        }
        return run;
      });
    });
}

describe("the sample PDFs", () => {
  it.each(PDFS.map((d) => [d.id, d] as const))(
    "%s renders to the committed bytes",
    async (_id, doc: PdfDoc) => {
      const bytes = await renderPdf(doc);
      expect(bytes.equals(readFileSync(join(PUBLIC, doc.file)))).toBe(true);
      expect(pdfPageCount(bytes)).toBe(1);
      expect(pdfSubject(bytes)).toBe(PDF_FOOTER);
      const text = bytes.toString("latin1");
      expect(text).toContain("/Subject");
      expect(text).toContain("/Helvetica-Bold");
      // The SAMPLE header and the footer are drawn on the page, not only in the metadata: each
      // is one whole string in the page's content stream.
      const pages = drawnRuns(bytes);
      expect(pages).toHaveLength(1);
      for (const runs of pages) {
        expect(runs.filter((r) => r === "SAMPLE")).toHaveLength(1);
        expect(runs.filter((r) => r === PDF_FOOTER)).toHaveLength(1);
      }
    },
  );

  it("renders the same bytes twice", async () => {
    const [a, b] = await Promise.all([renderPdf(PDFS[0]), renderPdf(PDFS[0])]);
    expect(a.equals(b)).toBe(true);
  });

  it("prints every expected value, in ASCII only", () => {
    const ratecon = PDFS.find((d) => d.id === "br-l10259-ratecon") as RateConDoc;
    const runs = textRuns(pdfContent(ratecon));
    for (const s of [
      "Rate Confirmation",
      "BR-L10259",
      "Millbrook Textile Works, Spartanburg, SC",
      "Blue Ridge Freight Lines",
      "Charlotte, NC on 10/26/2026",
      "Atlanta, GA on 10/26/2026",
      "245",
      "Linehaul (245 mi x $2.80)",
      "$686.00",
      "$130.00",
      "$816.00",
      "BR-T122",
      "BR-D22",
    ]) {
      expect(runs).toContain(s);
    }
    const bol = PDFS.find((d) => d.id === "br-l10216-bol")!;
    const bolRuns = textRuns(pdfContent(bol));
    for (const s of [
      "Bill of Lading",
      "BR-L10216",
      "Greensboro, NC",
      "Columbus, OH",
      "Bluefern Beverage Group, Richmond, VA",
      "General freight, palletized",
      "22",
      "10/21/2026 7:40 AM EDT",
      "10/21/2026 8:22 AM EDT",
      "10/22/2026 4:05 AM EDT",
      "10/22/2026 11:25 AM EDT",
    ]) {
      expect(bolRuns).toContain(s);
    }
    for (const doc of PDFS) {
      for (const run of textRuns(pdfContent(doc))) {
        expect(run, `${doc.id}: ${run}`).toMatch(/^[\x20-\x7e]+$/);
      }
    }
  });

  it("counts pages and reads the subject from raw PDF text", () => {
    const raw = Buffer.from(
      "1 0 obj\n<< /Type /Pages /Kids [2 0 R 3 0 R] >>\nendobj\n" +
        "2 0 obj\n<< /Type /Page >>\nendobj\n3 0 obj\n<< /Type/Page >>\nendobj\n" +
        "4 0 obj\n<< /Subject 5 0 R >>\nendobj\n5 0 obj\n(A \\(b\\) c)\nendobj\n",
      "latin1",
    );
    expect(pdfPageCount(raw)).toBe(2);
    expect(pdfSubject(raw)).toBe("A (b) c");
    expect(pdfSubject(Buffer.from("<< /Title (x) >>"))).toBeNull();
  });
});
