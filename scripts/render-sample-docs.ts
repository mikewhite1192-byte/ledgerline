import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPdf, parseManifest } from "../src/lib/seed/docs/manifest";
import { pdfPageCount, renderPdf } from "../src/lib/seed/docs/pdf";

// npm run docs:render
//
// Renders the rate confirmations and bills of lading in src/lib/seed/docs/manifest.json to
// public/samples/docs/ and rewrites each entry's bytes, sha256 and page count. Deterministic,
// no network, no database: run it after changing a PDF entry or the layout, and commit the PDFs
// with the manifest. pdf.test.ts fails until the committed bytes match a fresh render.

const MANIFEST_PATH = join(process.cwd(), "src", "lib", "seed", "docs", "manifest.json");
const PUBLIC = join(process.cwd(), "public");

async function main(): Promise<void> {
  const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
  for (const entry of manifest.entries) {
    if (!isPdf(entry)) continue;
    const bytes = await renderPdf(entry);
    const target = join(PUBLIC, entry.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    entry.bytes = bytes.length;
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
    entry.pages = pdfPageCount(bytes);
    console.log(`${entry.file} ${entry.bytes} bytes ${entry.pages} page(s) sha256 ${entry.sha256}`);
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
