// @vitest-environment jsdom
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PAYSTUB } from "@/app/design/sample-data";
import { Paystub, type PaystubLine } from "@/components/app/paystub";
import { settlementInputOf } from "@/lib/data/records";
import type { TenantRows } from "@/lib/data/rows";
import { hrefOrNull, RECORD_PAGES, recordHref, type SourceRef } from "@/lib/records/href";
import { LINE_KINDS, settleDriver } from "@/lib/rules-engine";
import { DEMO_ANCHOR } from "@/lib/seed/anchor";
import { DEMO_CARRIERS } from "@/lib/seed/carriers";
import { buildCarrierPlan } from "@/lib/seed/plan";

// Every paystub line the demo can show, walked to its records: the paid weeks the seed writes and
// the open week a "Run the week" drafts (the rules engine on the seed's rows), for both carriers.
// Each line's records must link to a record page that is on disk, for a record the seed wrote, so
// no paystub link lands on a page that is not there.

type Walked = { where: string; kind: string; label: string; sources: SourceRef[] };
type Exception = { where: string; sources: SourceRef[] };

const RECORDS_DIR = join(process.cwd(), "src", "app", "records");

function walk(): { lines: Walked[]; exceptions: Exception[]; has: (carrier: string, ref: SourceRef) => boolean; chargeLoad: Map<string, string> } {
  const lines: Walked[] = [];
  const exceptions: Exception[] = [];
  const ids = new Set<string>();
  const chargeLoad = new Map<string, string>();
  for (const carrier of DEMO_CARRIERS) {
    const plan = buildCarrierPlan(carrier, DEMO_ANCHOR);
    const rows = plan.rows as TenantRows;
    for (const [table, list] of Object.entries(rows)) {
      for (const r of list as { id?: string }[]) if (r.id) ids.add(`${carrier.slug}|${table}|${r.id}`);
    }
    for (const a of rows.load_accessorials) chargeLoad.set(a.id, a.load_id);
    for (const l of rows.settlement_lines) {
      lines.push({ where: `${carrier.slug} paid week`, kind: l.kind, label: l.label, sources: l.sources });
    }
    const openWeek = plan.periods[3];
    for (const d of rows.drivers) {
      const r = settleDriver(settlementInputOf(rows, d.id, openWeek));
      for (const l of r.lines) lines.push({ where: `${carrier.slug} open week ${d.code}`, kind: l.kind, label: l.label, sources: l.sources });
      for (const x of r.exceptions) exceptions.push({ where: `${carrier.slug} open week ${d.code}`, sources: x.sources });
    }
  }
  const has = (carrier: string, ref: SourceRef) => ids.has(`${carrier}|${ref.table}|${ref.id}`);
  return { lines, exceptions, has, chargeLoad };
}

const { lines, exceptions, has, chargeLoad } = walk();

// The page a link opens, or why it does not resolve.
function pageProblem(href: string): string | null {
  const m = /^\/records\/([a-z_]+)\/([0-9a-f-]{36})$/.exec(href);
  if (!m) return `not a record page link: ${href}`;
  return existsSync(join(RECORDS_DIR, m[1], "[id]", "page.tsx")) ? null : `no page file for ${m[1]}`;
}

afterEach(() => cleanup());

describe("every paystub line in the demo links to a page that exists", () => {
  it("the demo shows every kind of paystub line", () => {
    expect(new Set(lines.map((l) => l.kind))).toEqual(new Set(LINE_KINDS));
  });

  it("every record behind every line links to its page, for a record the seed wrote", () => {
    expect(lines.length).toBeGreaterThan(1000);
    const problems: string[] = [];
    for (const l of lines) {
      if (l.sources.length === 0) problems.push(`${l.where}: ${l.kind} "${l.label}" has no record`);
      for (const s of l.sources) {
        const href = hrefOrNull(recordHref, s);
        const carrier = l.where.split(" ")[0];
        if (href === null) problems.push(`${l.where}: ${l.kind} cites ${s.table}, which has no page`);
        else {
          const p = pageProblem(href);
          if (p) problems.push(`${l.where}: ${l.kind}: ${p}`);
        }
        if (!has(carrier, s)) problems.push(`${l.where}: ${l.kind} cites a ${s.table} record the seed did not write`);
        // An extra charge's page sends the reader on to its load, which must be there too.
        if (s.table === "load_accessorials") {
          const load = chargeLoad.get(s.id);
          if (!load || !has(carrier, { table: "loads", id: load })) problems.push(`${l.where}: an extra charge with no load`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("a problem's records link only to pages that exist, and the rest stay plain text", () => {
    expect(exceptions.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const x of exceptions) {
      for (const s of x.sources) {
        const href = hrefOrNull(recordHref, s);
        if (href === null) {
          if ((RECORD_PAGES as readonly string[]).includes(s.table)) problems.push(`${x.where}: ${s.table} has a page but no link`);
        } else {
          const p = pageProblem(href);
          if (p) problems.push(`${x.where}: ${p}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("a rendered paystub with one line of each kind shows each line's records as links to those pages", () => {
    // For each kind, the line that cites the most records, so the "and n more records" links are walked too.
    const pick = new Map<string, Walked>();
    for (const l of lines) {
      const best = pick.get(l.kind);
      if (!best || l.sources.length > best.sources.length) pick.set(l.kind, l);
    }
    const sample: PaystubLine[] = [...pick.values()].map((l, i) => ({ seq: i + 1, kind: l.kind, label: l.label, amountCents: 100, sources: l.sources }));
    expect(sample.map((l) => l.kind).sort()).toEqual([...LINE_KINDS].sort());
    expect(sample.some((l) => l.sources.length > 1)).toBe(true);

    const { container } = render(<Paystub {...PAYSTUB} lines={sample} exceptions={[]} />);
    const shown = [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "").filter((h) => h.startsWith("/records/"));
    const expected = sample.flatMap((l) => l.sources.map((s) => recordHref(s)));
    expect(expected.filter((h) => !shown.includes(h)), "a line's record shows without its link").toEqual([]);
    expect(shown.map(pageProblem).filter((p) => p !== null)).toEqual([]);
  });
});
