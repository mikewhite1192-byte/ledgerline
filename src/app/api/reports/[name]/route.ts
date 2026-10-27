import { NextResponse } from "next/server";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { parseReportQuery } from "@/lib/reports/args";
import { reportCsv } from "@/lib/reports/csv";
import { reportForSession } from "@/lib/reports/for-session";
import { capRows } from "@/lib/reports/types";

// GET: one report for the signed-in person's carrier, recomputed from the records with the same
// typed args the chat tool takes. format=csv (the default) downloads every row; format=json is the
// chat's table, capped at 50 rows like the tool result. Never cached. Off while the report switch
// is off.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// On every answer, JSON and CSV alike: never cached, and never sniffed as another type.
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function reply(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!flags.reportsEnabled) return reply({ error: "not_found" }, 404);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const { name } = await params;
  const query = parseReportQuery(name, new URL(request.url).searchParams);
  if (!query) return reply({ error: "bad_request" }, 400);
  try {
    const result = await reportForSession(session, query.request, new Date());
    if (query.format === "json") return reply(capRows(result), 200);
    return new NextResponse(reportCsv(result), {
      status: 200,
      headers: {
        ...NO_STORE,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${result.report}-${result.asOf}.csv"`,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return reply({ error: "forbidden" }, 403);
    console.error("report failed:", err instanceof Error ? err.name : "unknown");
    return reply({ error: "unavailable" }, 503);
  }
}
