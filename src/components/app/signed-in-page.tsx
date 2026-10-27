import type { ReactNode } from "react";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AppShell } from "./app-shell";
import { appNav, type NavKey } from "./app-nav";
import { ErrorState } from "./states";
import type { TenantInfo } from "./tenant-switcher";

export function SignOutForm() {
  return (
    <form action="/api/auth/sign-out" method="post">
      <Button type="submit" variant="ghost" className="w-full justify-start">
        Sign out
      </Button>
    </form>
  );
}

// A signed-in page inside the shell, with the app's nav and the carrier chip.
export function SignedInPage({
  tenant,
  current,
  title,
  children,
}: {
  tenant: TenantInfo;
  current: NavKey;
  title: string;
  children: ReactNode;
}) {
  return (
    <AppShell tenant={tenant} nav={appNav(current)} title={title} signOut={<SignOutForm />}>
      <div className="mx-auto grid w-full max-w-[960px] min-w-0 gap-6">{children}</div>
    </AppShell>
  );
}

// No carrier to show a shell for (no membership, or the read failed): the problem by category
// and a way out. Unknown is not empty, so this never reads as "no data".
export function NoCarrierPage({ problem }: { problem: "forbidden" | "unreadable" }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-4 pt-16 pb-10 sm:pt-24">
      <div className="grid w-full max-w-[440px] gap-6">
        <h1 className="sr-only">LedgerLine</h1>
        <Wordmark size="lg" className="justify-self-center" />
        <Card>
          <ErrorState category={problem} />
          <div className="border-t border-border p-3">
            <SignOutForm />
          </div>
        </Card>
      </div>
    </main>
  );
}
