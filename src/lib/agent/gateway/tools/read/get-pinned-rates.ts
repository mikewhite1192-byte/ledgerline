import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readPinnedRates } from "../../../../rates/read";
import { localDateOf } from "../../../../time/local-date";
import { defineTool, type GatewayRef } from "../../types";
import { dateField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

// The fuel and tax rates an admin pinned (GROUNDED-RATES design 4.2): the weekly diesel price or a
// state's fuel tax rate in effect on a day, each with the page it came from. Pins only: a looked-up
// suggestion nobody pinned is never returned, so nothing here is a guess. The agent reads; it
// cannot look a rate up or pin one. The page's title and the quoted text stay off the model: it
// gets the site and the address.

const STATE = /^[A-Z]{2}$/;

function siteOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export const getPinnedRates = defineTool({
  name: "get_pinned_rates",
  description:
    "Read the fuel rates a person pinned: kind diesel_index is the weekly U.S. diesel price a fuel " +
    "surcharge follows; kind ifta_rate is a state's fuel tax per gallon (state is the two-letter code; " +
    "every pinned state when left out). day is YYYY-MM-DD in the carrier's time zone (today when left " +
    "out). Each rate gives dollars per gallon, thousandths of a cent per gallon, the day it applies " +
    "from, the day it was pinned, whether it was typed by hand, and the source site and address. An " +
    "empty list means nothing is pinned for that day: say so, never estimate one. Nothing is written.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading the pinned fuel rates",
  enabled: () => flags.groundedRatesEnabled,
  args: z.strictObject({
    kind: z.enum(["diesel_index", "ifta_rate"]),
    state: z.string().regex(STATE).optional(),
    day: dateField().optional(),
  }),
  refs: (): GatewayRef[] => [],
  run: async (q, ctx, a) => {
    if (!flags.groundedRatesEnabled) throw new Error("fuel and tax rates are switched off");
    if (a.kind === "diesel_index" && a.state !== undefined) return { result: { error: "diesel_has_no_state" } };
    const day = a.day ?? localDateOf(ctx.now.toISOString(), ctx.timeZone);
    const rates = await readPinnedRates(q, a.kind, a.kind === "ifta_rate" ? a.state ?? null : null, day, ctx.timeZone);
    return {
      result: {
        day,
        kind: a.kind,
        rates: rates.map((r) => ({
          id: r.id,
          state: r.state,
          perGallon: r.perGallon,
          valueMcents: r.valueMcents,
          effectiveFrom: r.effectiveFrom,
          pinnedOn: r.pinnedOn,
          typed: r.typed,
          sourceSite: siteOf(r.sourceUrl),
          sourceUrl: r.sourceUrl,
        })),
      },
    };
  },
});
