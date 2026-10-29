import type { Metadata } from "next";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { SignedInPage } from "@/components/app/signed-in-page";
import { Wordmark } from "@/components/brand/wordmark";
import { HowPayWorks, type HeroPaystubLink } from "@/components/help/how-pay-works";
import { getSession } from "@/lib/auth/session";
import { readHeroLink } from "@/lib/help/hero-link";
import { withSessionTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "How trucking pay works",
  description: "How a trucking company is paid for loads and pays its drivers, with one driver's week worked to the cent.",
};

const TITLE = "How trucking pay works";
const LEAD = "Five short parts, one fictional driver's real week in the demo, every number to the cent.";

// Signed in: the shell for the carrier and, when it has the worked week's driver, the link to her
// paystub. Signed out (or a failed read): null, and the page shows without the shell. The public
// page reads no carrier's records; only a signed-in session reaches the read, in its own tenant.
async function signedIn(): Promise<{ shell: ShellTenant; paystub: HeroPaystubLink } | null> {
  try {
    const session = await getSession();
    if (!session) return null;
    return await withSessionTenant(session, async (q) => ({ shell: await readShell(q, session), paystub: await readHeroLink(q) }));
  } catch (err) {
    unstable_rethrow(err);
    console.error(`help: signed-in read failed (${err instanceof Error ? err.name : "unknown"})`);
    return null;
  }
}

export default async function HowPayWorksPage() {
  const view = await signedIn();
  if (view) {
    return (
      <SignedInPage tenant={view.shell} current="none" title={TITLE} help={null}>
        <PageHeader title={TITLE} description={LEAD} />
        <HowPayWorks paystub={view.paystub} signedIn />
      </SignedInPage>
    );
  }
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-10 pb-10 sm:pt-16">
      <div className="grid w-full max-w-[720px] min-w-0 gap-6">
        <Link href="/" aria-label="LedgerLine home" className="justify-self-center rounded-md">
          <Wordmark size="lg" />
        </Link>
        <PageHeader title={TITLE} description={LEAD} />
        <HowPayWorks paystub={null} signedIn={false} />
      </div>
    </main>
  );
}
