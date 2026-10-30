import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { listRequests } from "../../../../factoring/read";
import { defineTool, type GatewayRef } from "../../types";
import { OPERATOR_AUDITOR } from "../shared";

// The carrier's factoring requests, newest first: what each was planned to bring in, charge and
// hold back, what its funded invoices did bring in, and where it stands. Reads only; the Factoring
// page shows each request's invoices.
export const getFactoringRequests = defineTool({
  name: "get_factoring_requests",
  description:
    "List the carrier's factoring requests, newest first, in integer cents: invoices sold, the " +
    "planned net (netCents), the planned fee (feeCents) and the planned part held back until the " +
    "customer pays (reserveCents), each of which still counts an invoice that was declined or not " +
    "confirmed yet; what came in (cameInCents, the funded invoices only); and the status (submitted " +
    "or unknown means sent, not confirmed yet; funded; partly_funded; declined; failed). Test mode. " +
    "This only reads.",
  tier: "read",
  roles: OPERATOR_AUDITOR,
  label: "Reading the factoring requests",
  enabled: () => flags.factoring?.enabled === true,
  args: z.strictObject({ limit: z.int().min(1).max(20).optional() }),
  refs: (): GatewayRef[] => [],
  run: async (q, _ctx, a) => {
    if (flags.factoring?.enabled !== true) throw new Error("factoring is switched off");
    const rows = await listRequests(q, a.limit ?? 10);
    return {
      result: {
        requests: rows.map((r) => ({
          requestId: r.id,
          createdAt: r.createdAt,
          invoiceCount: r.invoiceCount,
          balanceCents: r.balanceCents,
          netCents: r.netCents,
          cameInCents: r.cameInCents,
          feeCents: r.feeCents,
          reserveCents: r.reserveCents,
          status: r.status,
          fundedAt: r.fundedAt,
          proposalId: r.proposalId,
        })),
      },
    };
  },
});
