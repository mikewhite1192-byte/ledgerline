import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { SignedInPage } from "@/components/app/signed-in-page";
import { PageNotFound } from "@/components/app/states";
import { Wordmark } from "@/components/brand/wordmark";
import { Card } from "@/components/ui/card";
import { getSession } from "@/lib/auth/session";
import { withSessionTenant } from "@/lib/tenant/context";
import { readShell, type ShellTenant } from "@/lib/tenant/shell";

// The carrier chip for the shell, or null when there is no one signed in or the read fails. A
// missing page never fails on top of that: it falls back to the page without the shell, and only
// the error's kind reaches the log. The framework's own signals (a request-time read during the
// build, a redirect) go on to the framework.
async function shellOrNull(): Promise<ShellTenant | null> {
  try {
    const session = await getSession();
    if (!session) return null;
    return await withSessionTenant(session, (q) => readShell(q, session));
  } catch (err) {
    unstable_rethrow(err);
    console.error(`not-found: shell read failed (${err instanceof Error ? err.name : "unknown"})`);
    return null;
  }
}

// Any address with no page behind it, and any page that calls notFound(): inside the signed-in
// shell with the menu when someone is signed in, so a mistyped or old link is never a dead end.
export default async function NotFound() {
  const shell = await shellOrNull();
  if (shell) {
    return (
      <SignedInPage tenant={shell} current="none" title="Page not found">
        <PageNotFound />
      </SignedInPage>
    );
  }
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[440px] gap-6">
        <Link href="/" aria-label="LedgerLine home" className="justify-self-center rounded-md">
          <Wordmark size="lg" />
        </Link>
        <Card>
          <PageNotFound />
        </Card>
      </div>
    </main>
  );
}
