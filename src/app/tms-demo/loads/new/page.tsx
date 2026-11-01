import { randomInt } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorState } from "@/components/app/states";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { flags } from "@/config/flags";
import { DbError } from "@/lib/db";
import { formatPeriod } from "@/lib/format/dates";
import { readNewLoadForm, type NewLoadFormView } from "@/lib/mock-tms/new-load";
import { demoCarrierOf } from "@/lib/seed/reset";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { NewLoadForm } from "./new-load-form";

export const dynamic = "force-dynamic";

type View = { kind: "ready"; form: NewLoadFormView } | { kind: "off_mock" };

// MOCK-TMS: the sample dispatch system's "New load" form. It writes the sample system's load and
// LedgerLine's planned load with the same number at once (src/lib/mock-tms/new-load.ts). While
// flags.mockTms.newLoad is off this page does not exist. Signed out: withRequestTenant redirects.
export default async function NewMockLoadPage() {
  if (flags.mockTms.enabled !== true || flags.mockTms.newLoad !== true) notFound();
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant<View | null>(async (q) => {
      if (!(await demoCarrierOf(q))) return null;
      const form = await readNewLoadForm(q, Date.now());
      return form === null ? { kind: "off_mock" } : { kind: "ready", form };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (problem) return <ErrorState category={problem} />;
  if (view === null) notFound();

  return (
    <div className="grid gap-6">
      <Link href="/tms-demo" className="text-body text-foreground underline">
        All loads
      </Link>
      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>New load</CardTitle>
            <CardDescription>
              Create a load here as a dispatcher would. LedgerLine gets its own planned load with the same number.
            </CardDescription>
          </div>
        </CardHeader>
        <CardBody className="grid gap-5">
          {view.kind === "off_mock" ? (
            <p className="text-body text-foreground-2">
              This carrier still reads the built-in demo feed. A demo reset puts it on the sample dispatch system.
            </p>
          ) : (
            <>
              <ul className="grid gap-1 text-body text-foreground-2">
                <li>LedgerLine links this load by its number on the next sync.</li>
                <li>
                  {view.form.openWeek === null
                    ? "A paystub drafts only for a delivery inside an open pay week, and none is open now."
                    : `A paystub drafts only for a delivery inside the open pay week (${formatPeriod(view.form.openWeek.start, view.form.openWeek.end)}).`}
                </li>
                <li>{`${view.form.made} of ${flags.mockTms.maxNewLoads} new loads used; a demo reset clears them.`}</li>
              </ul>
              <NewLoadForm
                suggestedNumber={`NEW-${randomInt(1000, 10000)}`}
                today={view.form.today}
                customers={view.form.customers.map((c) => ({ value: c.code, label: c.name }))}
                drivers={view.form.drivers.map((d) => ({ value: d.externalId, label: d.name }))}
              />
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
