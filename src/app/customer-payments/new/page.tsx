import { Wallet } from "lucide-react";
import { flags } from "@/config/flags";
import { PageHeader } from "@/components/app/page-header";
import { NoCarrierPage, SignedInPage } from "@/components/app/signed-in-page";
import { EmptyState } from "@/components/app/states";
import { Card, CardBody } from "@/components/ui/card";
import { PaymentForm } from "@/components/invoices/payment-form";
import { DbError } from "@/lib/db";
import { readPaymentForm, type PaymentFormCustomer } from "@/lib/invoices/views";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { carrierToday, readShell, type ShellTenant } from "@/lib/tenant/shell";
import type { LocalDate } from "@/lib/time/local-date";

export const dynamic = "force-dynamic";

type View = { shell: ShellTenant; form: { customers: PaymentFormCustomer[]; today: LocalDate } | null };

// Record one customer payment. The form's invoice list is each customer's open invoices, oldest due
// first, read in the request's tenant transaction.
export default async function NewPayment({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const asked = (await searchParams).customer;
  let view: View | null = null;
  let problem: "forbidden" | "unreadable" | null = null;
  try {
    view = await withRequestTenant(async (q, session): Promise<View> => {
      const shell = await readShell(q, session);
      if (!flags.customerPaymentsEnabled) return { shell, form: null };
      const today = carrierToday(shell.timezone, new Date());
      return { shell, form: { customers: await readPaymentForm(q, today), today } };
    });
  } catch (err) {
    if (err instanceof ForbiddenError) problem = "forbidden";
    else if (err instanceof DbError) problem = "unreadable";
    else throw err;
  }
  if (!view) return <NoCarrierPage problem={problem ?? "unreadable"} />;

  return (
    <SignedInPage tenant={view.shell} current="/customer-payments/new" title="Record a payment">
      <PageHeader
        title="Record a payment"
        description="A check, ACH or wire from a customer, applied to their open invoices. What is not applied stays as credit."
      />
      {view.form === null ? (
        <EmptyState
          icon={<Wallet aria-hidden />}
          title="Recording payments is off in this environment"
          body="Nothing here is read or written until it is switched on."
        />
      ) : view.form.customers.length === 0 ? (
        <EmptyState icon={<Wallet aria-hidden />} title="No customers yet" body="Customers come with the carrier's data." />
      ) : (
        <Card>
          <CardBody>
            <PaymentForm
              customers={view.form.customers}
              today={view.form.today}
              initialCustomerId={typeof asked === "string" ? asked : undefined}
            />
          </CardBody>
        </Card>
      )}
    </SignedInPage>
  );
}
