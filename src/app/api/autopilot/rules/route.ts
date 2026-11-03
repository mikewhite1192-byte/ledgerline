import { flags } from "@/config/flags";
import { readRole } from "@/lib/auth/role";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { parseRuleSave, readRules, saveRule } from "@/lib/autopilot/rules-admin";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { assertMembership } from "@/lib/tenant/context";
import { failed, objectBody, refused, reply } from "../../sweeps/reply";

// The owner's autopilot rules (docs: AUTOPILOT-RULES, D-094). Both answer 404 while
// flags.autopilotRules is off.
// GET: every rule of the caller's carrier and, per kind, what the autopilot may do there, plus the
// pause. Any member reads (admin, staff and a demo visitor).
// POST: one rule save, { kind, mode, maxCents, dayMaxCents, dayMaxCount, driverDayMaxCents?,
// expectedVersion }, by an admin only. Auto on a kind a named person always approves is refused
// (never_alone), a limit above the kind's ceiling is refused (over_ceiling), and a save on a version
// that moved answers changed with the rule as it is now. The rule and its record are written in one
// transaction (src/lib/autopilot/rules-admin.ts). Nothing here approves, pays or sends.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET() {
  if (flags.autopilotRules.enabled !== true) return refused("not_found");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  try {
    const picture = await getDb().withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      return readRules(q, Date.now());
    });
    return reply(picture, 200);
  } catch (err) {
    return failed("autopilot rules read", err);
  }
}

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  // The switch is read here and again by the page.
  if (flags.autopilotRules.enabled !== true) return refused("not_found");
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const body = await objectBody(request, 2_000);
  const parsed = parseRuleSave(body);
  try {
    const out = await getDb().withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      if ((await readRole(q, session)) !== "admin") return { ok: false, category: "role" } as const;
      if (!parsed.ok) return parsed;
      return saveRule(q, session, parsed.value, new Date());
    });
    if (out.ok) return reply(out.unchanged ? { ok: true, rule: out.rule, unchanged: true } : { ok: true, rule: out.rule }, 200);
    switch (out.category) {
      case "bad_request":
        return refused("bad_request", { field: out.field });
      case "over_ceiling":
        return refused("over_ceiling", { ceiling: out.ceiling });
      case "changed":
        return refused("changed", { rule: out.rule });
      default:
        return refused(out.category);
    }
  } catch (err) {
    return failed("autopilot rules save", err);
  }
}
