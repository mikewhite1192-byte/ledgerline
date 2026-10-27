import Link from "next/link";
import { ErrorState } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { connectionSummary, membershipOf } from "@/lib/adapters/accounting/qbo/store";
import { DbError } from "@/lib/db";
import { formatInstant } from "@/lib/format/dates";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

export const dynamic = "force-dynamic";

type Note = { tone: "success" | "info" | "warning" | "destructive"; text: string };

// One fixed sentence per word the QuickBooks routes send back; any other value shows nothing.
const NOTES: Record<string, Note> = {
  connected: { tone: "success", text: "Connected to the QuickBooks sandbox company." },
  disconnected: { tone: "info", text: "Disconnected. Nothing will be booked to QuickBooks." },
  forbidden: { tone: "warning", text: "Only an admin of this carrier can connect or disconnect QuickBooks." },
  not_configured: { tone: "warning", text: "QuickBooks is not set up for this app yet. Nothing was changed." },
  expired: { tone: "warning", text: "That sign-in to QuickBooks expired or was already used. Connect again." },
  not_allowed: { tone: "destructive", text: "That company is not allowed. Nothing stayed connected." },
  declined: { tone: "info", text: "QuickBooks was not connected." },
  disabled: {
    tone: "warning",
    text: "Accounting is off, so LedgerLine could not set up its accounts in QuickBooks. Nothing stayed connected.",
  },
  failed: { tone: "destructive", text: "QuickBooks could not be connected. Nothing was saved. Try again in a moment." },
};

type View = {
  admin: boolean;
  timezone: string;
  connection: { realmTail: string; connectedAt: string } | null;
};

// The carrier's QuickBooks connection: the sandbox company's last four digits and when it was
// connected, and connect or disconnect for an admin. Signed out: withRequestTenant redirects.
export default async function AccountingSettings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const qbo = (await searchParams).qbo;
  const note = typeof qbo === "string" && Object.hasOwn(NOTES, qbo) ? NOTES[qbo] : null;
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session) => {
      const [tenant] = await q.query<{ timezone: string }>(
        "SELECT timezone FROM tenants WHERE id = current_tenant_id()",
      );
      const member = await membershipOf(q, session.sub);
      if (!tenant || !member) throw new ForbiddenError();
      return {
        admin: member.role === "admin",
        timezone: tenant.timezone,
        connection: await connectionSummary(q),
      };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }

  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[520px] gap-6">
        <Link href="/" aria-label="LedgerLine home" className="justify-self-center rounded-md">
          <Wordmark size="lg" />
        </Link>
        <h1 className="text-h2 text-foreground">Accounting</h1>
        {note ? <InlineAlert tone={note.tone}>{note.text}</InlineAlert> : null}
        <Card>
          {view ? (
            <>
              <CardHeader>
                <div className="grid gap-0.5">
                  <CardTitle>QuickBooks sandbox</CardTitle>
                  <CardDescription>
                    {view.connection
                      ? `Connected to the company ending ${view.connection.realmTail} since ${formatInstant(view.connection.connectedAt, view.timezone)}.`
                      : "Not connected. Nothing is booked to QuickBooks."}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardBody>
                {!view.admin ? (
                  <p className="text-body text-foreground-2">An admin of this carrier can change this.</p>
                ) : view.connection ? (
                  <form action="/api/qbo/disconnect" method="post">
                    <Button type="submit" variant="outline">
                      Disconnect
                    </Button>
                  </form>
                ) : (
                  // A plain link, never prefetched: following it starts the connection.
                  <a href="/api/qbo/connect" className={buttonVariants({ variant: "primary" })}>
                    Connect QuickBooks
                  </a>
                )}
              </CardBody>
            </>
          ) : (
            <ErrorState category={problem === "forbidden" ? "forbidden" : "unreadable"} />
          )}
        </Card>
      </div>
    </main>
  );
}
