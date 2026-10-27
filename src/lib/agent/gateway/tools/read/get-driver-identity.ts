import { z } from "zod";
import { readDriverIdentity } from "../../../../advances/identity";
import { defineTool } from "../../types";
import { idField } from "../../validate";
import { OPERATOR_AUDITOR } from "../shared";

export const getDriverIdentity = defineTool({
  name: "get_driver_identity",
  description:
    "Read one driver's identity map: whether they are armed to receive money and since when, the " +
    "ids other systems know them by, and the fuel cards on file with last four digits, portal " +
    "name and which is the default.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading the driver's identity map",
  args: z.strictObject({ driverId: idField() }),
  refs: (a) => [{ table: "drivers", id: a.driverId }],
  run: async (q, _ctx, a) => {
    const identity = await readDriverIdentity(q, a.driverId);
    if (!identity) throw new Error("driver vanished after the ref check");
    // Last four digits and portal placeholders only; a card's token is never read here.
    return {
      result: {
        driver: {
          id: identity.driverId,
          code: identity.code,
          armed: identity.armed.on,
          armedSince: identity.armed.since,
          tmsIds: identity.tmsIds,
          cards: identity.cards.map((c) => ({
            id: c.id,
            last4: c.last4,
            status: c.status,
            isDefault: c.isDefault,
            holderKind: c.holderKind,
            portalName: c.portalName,
            testMode: c.testMode,
          })),
        },
      },
    };
  },
});
