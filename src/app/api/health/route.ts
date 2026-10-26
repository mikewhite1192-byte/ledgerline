import { NextResponse } from "next/server";

// Deploy check: the commit this build came from, so a deploy can be confirmed by version.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    version: process.env.APP_COMMIT ?? "local",
  });
}
