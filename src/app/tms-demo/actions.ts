"use server";

import { revalidatePath } from "next/cache";
import { flags } from "@/config/flags";
import { readRole } from "@/lib/auth/role";
import { DbError } from "@/lib/db";
import { sendMockHook, type HookResult } from "@/lib/mock-tms/hook";
import { applyMockAction, recordHookResult, type MockAction, type MockRefusal } from "@/lib/mock-tms/store";
import { demoCarrierOf } from "@/lib/seed/reset";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

// MOCK-TMS: the sample dispatch system's buttons (/tms-demo/loads/[ref]). Each one changes only that
// stand-in system's own store (src/lib/mock-tms/store.ts), in one tenant transaction, then calls our
// webhook route over HTTP the way a real dispatch system would, and keeps that call's category on
// the load. Any member of a demo carrier may press them, a demo visitor too (src/lib/auth/
// judge-allowlist.ts): they write only the sample system's rows, never our loads, cards or money,
// and the desk reads the change through the read-only dispatch source like any other. The page's
// switch is re-checked first; a carrier that is not a demo carrier, or not on the sample system, is
// refused. Categories only, never a database message.

export type MockActionCategory = MockRefusal | "disabled" | "forbidden" | "not_demo" | "bad_request" | "unreadable" | "unknown" | "failed";

export type MockActionState = { ok: true; hook: HookResult } | { ok: false; category: MockActionCategory } | null;

class NotDemoCarrier extends Error {
  constructor() {
    super("not a demo carrier");
    this.name = "NotDemoCarrier";
  }
}

const UNREACHABLE: ReadonlySet<DbError["category"]> = new Set(["resuming", "unavailable", "timeout"]);

const text = (form: FormData, name: string): string | null => {
  const v = form.get(name);
  return typeof v === "string" && v.trim().length > 0 && v.length <= 120 ? v.trim() : null;
};

async function run(form: FormData, actionOf: (form: FormData) => MockAction | null): Promise<MockActionState> {
  if (flags.mockTms.enabled !== true) return { ok: false, category: "disabled" };
  const reference = text(form, "reference");
  const action = actionOf(form);
  if (reference === null || action === null) return { ok: false, category: "bad_request" };
  try {
    const done = await withRequestTenant(async (q, session) => {
      const role = await readRole(q, session);
      if (!(await demoCarrierOf(q))) throw new NotDemoCarrier();
      const out = await applyMockAction(q, reference, action, role, {
        nowMs: Date.now(),
        maxEventsPerLoad: flags.mockTms.maxEventsPerLoad,
      });
      return { out, tenantId: session.tenantId };
    });
    if (!done.out.ok) return { ok: false, category: done.out.category };
    const externalId = done.out.externalId;
    // After the commit, never inside it: a send that fails changes nothing already written.
    const hook = await sendMockHook(done.tenantId, externalId);
    try {
      await withRequestTenant((q) => recordHookResult(q, externalId, hook, new Date().toISOString()));
    } catch (err) {
      console.error(`mock tms hook result not kept: ${err instanceof Error ? err.name : "unknown"}`);
    }
    return { ok: true, hook };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, category: "forbidden" };
    if (err instanceof NotDemoCarrier) return { ok: false, category: "not_demo" };
    if (err instanceof DbError) {
      console.error(`mock tms change: database ${err.category}${err.sqlState ? ` ${err.sqlState}` : ""}`);
      // A lost COMMIT reply: the change may have landed, so never say nothing changed.
      if (err.category === "unknown") return { ok: false, category: "unknown" };
      return { ok: false, category: UNREACHABLE.has(err.category) ? "unreadable" : "failed" };
    }
    throw err;
  } finally {
    revalidatePath("/tms-demo", "layout");
  }
}

export async function assignDriverAction(_prev: MockActionState, form: FormData): Promise<MockActionState> {
  return run(form, (f) => {
    const driver = text(f, "driver");
    return driver === null ? null : { kind: "assign_driver", driverExternalId: driver };
  });
}

export async function completePickupAction(_prev: MockActionState, form: FormData): Promise<MockActionState> {
  return run(form, (f) => ({ kind: "complete_pickup", arrivedLocal: text(f, "arrived"), departedLocal: text(f, "departed") }));
}

export async function completeDeliveryAction(_prev: MockActionState, form: FormData): Promise<MockActionState> {
  return run(form, (f) => ({ kind: "complete_delivery", arrivedLocal: text(f, "arrived"), departedLocal: text(f, "departed") }));
}

export async function setStatusAction(_prev: MockActionState, form: FormData): Promise<MockActionState> {
  return run(form, (f) => {
    const code = text(f, "status");
    return code === null ? null : { kind: "set_status", code };
  });
}
