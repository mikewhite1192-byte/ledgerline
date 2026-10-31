import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { readCardLoads } from "../../../../data/card-loads";
import { addDays, localDateOf } from "../../../../time/local-date";
import { defineTool } from "../../types";
import { OPERATOR_AUDITOR } from "../shared";

// The fuel card loads on the card statement (CARD-LOAD-RULING), newest first: whether a payment
// record stands behind each, whose card it is and the ruling a person made on it. A card shows by
// its last four digits only; the token never leaves the database. Behind the ruling's switch, read
// on every offer and every call, and again here. The model reads and explains; the ruling card is
// drafted by code and decided by a named person.

export const CARD_LOAD_DAYS = 14;
export const CARD_LOAD_LIMIT = 20;

export const getCardLoads = defineTool({
  name: "get_card_loads",
  description:
    "List the fuel card loads on the card statement over the last `days` days (default 14), newest " +
    "first: the amount in integer cents, the card's last four digits, the driver whose card it is, " +
    "whether a payment record stands behind it (recorded or no_record) and the ruling on it if one " +
    "was drafted: its status, the ruling a person made (owes_nothing or deficit), who decided it and " +
    "the deficit it booked.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading card loads",
  enabled: () => flags.cardLoadRuling.enabled,
  args: z.strictObject({
    days: z.int().min(1).max(60).optional(),
    limit: z.int().min(1).max(50).optional(),
  }),
  refs: () => [],
  run: async (q, ctx, a) => {
    if (!flags.cardLoadRuling.enabled) throw new Error("the card load ruling is switched off");
    const days = a.days ?? CARD_LOAD_DAYS;
    const today = localDateOf(ctx.now.toISOString(), ctx.timeZone);
    const window = { start: addDays(today, -(days - 1)), end: today };
    const loads = await readCardLoads(q, window, a.limit ?? CARD_LOAD_LIMIT);
    const rows = loads.map((l) => ({
      id: l.id,
      postedOn: l.postedOn,
      cardLast4: l.cardLast4,
      amountCents: l.amountCents,
      driver: l.driver,
      record: l.record,
      ruling: l.ruling,
    }));
    return { result: { from: window.start, to: window.end, rows } };
  },
});
