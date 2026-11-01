import type { Queryable } from "../db";
import { readRowsWhereId, readTable } from "../data/read";
import { recordHref } from "../records/href";
import { compareText } from "../rules-engine";
import { HERO_DRIVER } from "./hero-week";

// Where the help page's "See her paystub" goes for a signed-in carrier: the worked week's driver's
// draft paystub for the newest open week that has one once a week has been run (with two open
// weeks, D-090, the newer week first), otherwise her driver page (her paystubs so far). Null when
// this carrier has no such driver. Read only, through the scoped helpers, inside the caller's
// tenant transaction.
export type HeroLink = { href: string; draft: boolean };

export async function readHeroLink(q: Queryable): Promise<HeroLink | null> {
  const hero = (await readTable(q, "drivers")).find((d) => d.code === HERO_DRIVER.code);
  if (!hero) return null;
  const open = (await readTable(q, "settlement_periods"))
    .filter((p) => p.status === "open")
    .sort((a, b) => compareText(b.period_start, a.period_start));
  if (open.length > 0) {
    const stubs = await readRowsWhereId(q, "settlements", "driver_id", hero.id);
    for (const week of open) {
      const draft = stubs.find((s) => s.period_id === week.id);
      if (draft) return { href: recordHref({ table: "settlements", id: draft.id }), draft: true };
    }
  }
  return { href: recordHref({ table: "drivers", id: hero.id }), draft: false };
}
