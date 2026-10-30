import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineAlert } from "@/components/ui/inline-alert";
import { connectionSummary } from "@/lib/adapters/accounting/qbo/store";
import { DbError } from "@/lib/db";
import { formatInstant } from "@/lib/format/dates";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

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
  shell: ShellTenant;
  admin: boolean;
  connection: { realmTail: string; connectedAt: string } | null;
};

// The carrier's QuickBooks connection, inside the signed-in shell under Settings: the sandbox
// company's last four digits and when it was connected, and connect or disconnect for an admin.
// Signed out: withRequestTenant redirects.
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
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      // The shell's role: a demo visitor reads this page too; only an admin sees the connect button.
      return {
        shell,
        admin: shell.role === "admin",
        connection: await connectionSummary(q),
      };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }

  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;

  return (
    <SignedInPage tenant={view.shell} current="/settings/accounting" title="QuickBooks">
      <PageHeader
        title="QuickBooks"
        description="Where approved invoices and customer payments are booked. This app connects only to a QuickBooks sandbox company."
      />
      {note ? <InlineAlert tone={note.tone}>{note.text}</InlineAlert> : null}
      <Card className="max-w-[640px]">
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>QuickBooks sandbox</CardTitle>
            <CardDescription>
              {view.connection
                ? `Connected to the company ending ${view.connection.realmTail} since ${formatInstant(view.connection.connectedAt, view.shell.timezone)}.`
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
      </Card>
    </SignedInPage>
  );
}
