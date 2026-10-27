import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday, readShell, type ShellTenant } from "@/lib/tenant/shell";
import type { LocalDate } from "@/lib/time/local-date";
import { isUuid } from "@/lib/uuid";

export type RecordRead<T> =
  | { kind: "ok"; shell: ShellTenant; today: LocalDate; record: T }
  | { kind: "missing"; shell: ShellTenant }
  | { kind: "problem"; problem: "forbidden" | "unreadable" };

// One record page's read: the shell and the record in the request's tenant transaction. An id
// that is not a UUID, or a record this carrier does not have, is "missing" (never another
// carrier's row: every read names the tenant). A failed read is a problem, never an empty page.
export async function readRecordPage<T>(
  rawId: string,
  read: (q: Queryable, id: string, today: LocalDate, session: Session) => Promise<T | null>,
): Promise<RecordRead<T>> {
  try {
    return await withRequestTenant(async (q, session): Promise<RecordRead<T>> => {
      const shell = await readShell(q, session);
      if (!isUuid(rawId)) return { kind: "missing", shell };
      const today = carrierToday(shell.timezone, new Date());
      const record = await read(q, rawId.toLowerCase(), today, session);
      return record === null ? { kind: "missing", shell } : { kind: "ok", shell, today, record };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return { kind: "problem", problem: "forbidden" };
    if (err instanceof DbError) return { kind: "problem", problem: "unreadable" };
    throw err;
  }
}
