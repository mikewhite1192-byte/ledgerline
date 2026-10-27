import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { stampText } from "../portal/zones";
import type { PortalLoadSeed } from "./portal";

// The signed POD the fictional portal serves for one load: one page, the red SAMPLE header, the
// fictional-portal footer. Pure like the other seed PDFs (fixed dates, built-in fonts, no
// compression), so the same row gives the same bytes and the same hash.

const CREATED = new Date("2026-10-27T00:00:00Z");
const RED = "#b42318";
const INK = "#1a1a1a";
const MUTED = "#555555";
const RULE = "#c8c8c8";
const LEFT = 72;
const VALUE_X = 210;
export const POD_FOOTER = "Fictional demo portal. Not a real company. All data is synthetic.";
export const POD_MAX_BYTES = 100_000;

export type RenderedPod = { bytes: Buffer; hash: string };

export async function renderPortalPod(load: PortalLoadSeed, carrierName: string): Promise<RenderedPod> {
  if (load.podStatus !== "available" || !load.podSignedBy || !load.podSignedAt || !load.checkedOut) {
    throw new Error("only a signed load has a POD");
  }
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 72, bottom: 72, left: LEFT, right: LEFT },
    compress: false,
    info: { Title: `Proof of delivery ${load.reference} (SAMPLE)`, Subject: POD_FOOTER, CreationDate: CREATED, ModDate: CREATED },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const { width, height } = doc.page;
  const right = width - LEFT;
  doc.page.margins.bottom = 0;
  doc.font("Helvetica-Bold").fontSize(14).fillColor(RED);
  doc.text("SAMPLE", LEFT, 36, { width: right - LEFT, align: "center", lineBreak: false });
  let y = 84;
  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK);
  doc.text("Proof of Delivery", LEFT, y, { lineBreak: false });
  y += 34;
  doc.moveTo(LEFT, y).lineTo(right, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 14;
  const fields: [string, string][] = [
    ["Broker reference", load.reference],
    ["Carrier load number", load.loadNumber],
    ["Carrier", carrierName],
    ["Shipper", load.shipperName],
    ["Consignee", `${load.consigneeName}, ${load.consigneeCity}, ${load.consigneeState}`],
    ["Delivered", stampText(load.checkedOut, load.facilityTimeZone)],
    ["Received by", load.podSignedBy],
    ["Condition", "Received in good order"],
  ];
  for (const [label, value] of fields) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(MUTED);
    doc.text(label, LEFT, y, { lineBreak: false });
    doc.font("Helvetica").fontSize(11).fillColor(INK);
    doc.text(value, VALUE_X, y - 1, { lineBreak: false });
    y += 22;
  }
  y += 40;
  doc.font("Helvetica-Oblique").fontSize(18).fillColor(INK);
  doc.text(load.podSignedBy, LEFT + 4, y - 22, { lineBreak: false });
  doc.moveTo(LEFT, y).lineTo(LEFT + 260, y).lineWidth(0.75).strokeColor(INK).stroke();
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  doc.text("Consignee signature", LEFT, y + 6, { lineBreak: false });
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  doc.text(POD_FOOTER, LEFT, height - 44, { width: right - LEFT, align: "center", lineBreak: false });
  doc.end();
  const bytes = await done;
  if (bytes.length > POD_MAX_BYTES) throw new Error("a POD is larger than the portal allows");
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}
