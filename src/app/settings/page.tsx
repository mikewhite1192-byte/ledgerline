import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { HOW_PAY_WORKS, NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { Card } from "@/components/ui/card";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";
import { settingsRows, type SettingsRow } from "./rows";

export const dynamic = "force-dynamic";

function Rows({ rows, label }: { rows: SettingsRow[]; label: string }) {
  return (
    <Card>
      <ul aria-label={label} className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.href}>
            <Link
              href={r.href}
              className="flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-accent"
            >
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-body font-medium text-foreground">{r.label}</span>
                {r.help ? <span className="text-small text-foreground-2">{r.help}</span> : null}
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// Settings: one list of the carrier's settings pages, so they have one obvious place. Nothing is
// read beyond the carrier's shell. Signed out: withRequestTenant redirects.
export default async function SettingsPage() {
  let shell: ShellTenant | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    shell = await withRequestTenant((q, session) => readShell(q, session));
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (!shell) return <NoCarrierPage problem={problem ?? "unreadable"} />;
  const { rows, models } = settingsRows();

  return (
    <SignedInPage tenant={shell} current="/settings" title="Settings">
      <PageHeader title="Settings" description={`How ${shell.name} is set up.`} />
      {rows.length > 0 ? <Rows rows={rows} label="Settings" /> : null}
      {models ? (
        <section aria-labelledby="settings-curious" className="grid gap-2">
          <h2 id="settings-curious" className="text-small text-foreground-2">
            For the curious: which models did the work and what it cost.
          </h2>
          <Rows rows={[models]} label="Models and spend" />
        </section>
      ) : null}
      <p className="text-small">
        <Link href={HOW_PAY_WORKS.href} className="text-link underline-offset-4 hover:underline">
          {HOW_PAY_WORKS.label}
        </Link>
      </p>
    </SignedInPage>
  );
}
