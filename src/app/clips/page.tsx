import { Video } from "lucide-react";
import { appNav } from "@/components/app/app-nav";
import { AppShell } from "@/components/app/app-shell";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { ClipsPanel } from "@/components/clips/clips-panel";
import type { LoadOption } from "@/components/clips/redactor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { listClips } from "@/lib/clips/service";
import type { ClipView } from "@/lib/clips/types";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

// Dock clips: upload a short clip of a stop, see it blurred, and see whether its clocks agree with
// the stored stop times. Behind clipsEnabled; off, the page says so and reads nothing else.
export const dynamic = "force-dynamic";

type Carrier = { name: string; timezone: string; email: string; session: Session; loads: LoadOption[] };

const LOAD_LIMIT = 100;

export default async function ClipsPage() {
  let carrier: Carrier | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    carrier = await withRequestTenant(async (q, session) => {
      const tenants = await q.query<{ name: string; timezone: string }>(
        "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()",
      );
      const members = await q.query<{ email: string }>(
        "SELECT email FROM memberships WHERE cognito_sub = $1 AND tenant_id = current_tenant_id()",
        [session.sub],
      );
      if (tenants.length !== 1 || members.length !== 1) throw new ForbiddenError();
      const loads = flags.clipsEnabled
        ? await q.query<{ id: string; load_number: string; dest_city: string; dest_state: string }>(
            `SELECT id, load_number, dest_city, dest_state FROM loads
              WHERE status IN ('in_transit', 'delivered', 'invoiced')
              ORDER BY pickup_on DESC, load_number LIMIT ${LOAD_LIMIT}`,
          )
        : [];
      return {
        name: tenants[0].name,
        timezone: tenants[0].timezone,
        email: members[0].email,
        session,
        loads: loads.map((l) => ({
          id: l.id,
          loadNumber: l.load_number,
          label: `${l.load_number} to ${l.dest_city}, ${l.dest_state}`,
        })),
      };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }

  const signOut = (
    <form action="/api/auth/sign-out" method="post">
      <Button type="submit" variant="ghost" className="w-full justify-start">
        Sign out
      </Button>
    </form>
  );

  if (!carrier) {
    return (
      <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
        <div className="grid w-full max-w-[440px] gap-6">
          <h1 className="sr-only">LedgerLine</h1>
          <Wordmark size="lg" className="justify-self-center" />
          <Card>
            <ErrorState category={problem === "forbidden" ? "forbidden" : "unreadable"} />
            <div className="border-t border-border p-3">{signOut}</div>
          </Card>
        </div>
      </main>
    );
  }

  // Unknown is not zero: a list that cannot be read shows the error, never an empty list.
  let clips: ClipView[] | null = null;
  if (flags.clipsEnabled) {
    try {
      const result = await listClips(carrier.session, null);
      clips = result.ok ? result.clips : null;
    } catch (err) {
      console.error("clip list failed:", err instanceof Error ? err.name : "unknown");
    }
  }

  return (
    <AppShell
      tenant={{ name: carrier.name, email: carrier.email, timezone: carrier.timezone }}
      nav={appNav("/clips")}
      title="Dock clips"
      signOut={signOut}
    >
      <div className="mx-auto grid w-full max-w-[1080px] gap-6">
        <PageHeader
          title="Dock clips"
          description="A short clip of a pickup or delivery. Faces and plates are blurred in your browser before the clip is saved, and the camera clock is checked against the stored stop times."
        />
        {!flags.clipsEnabled ? (
          <Card>
            <EmptyState icon={<Video aria-hidden />} title="Dock clips are turned off" body="Nothing is uploaded or read while they are off." />
          </Card>
        ) : clips ? (
          <ClipsPanel clips={clips} loads={carrier.loads} />
        ) : (
          <Card>
            <ErrorState
              category="unreadable"
              retry={
                <a href="/clips" className="text-small font-medium text-primary underline-offset-2 hover:underline">
                  Try again
                </a>
              }
            />
          </Card>
        )}
      </div>
    </AppShell>
  );
}
