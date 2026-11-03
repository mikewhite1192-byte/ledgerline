import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { flags } from "@/config/flags";

// MOCK-TMS: the sample dispatch system's own plain shell. While flags.mockTms is off, none of its
// pages exist.
export default function TmsDemoLayout({ children }: { children: ReactNode }) {
  if (flags.mockTms.enabled !== true) notFound();
  return (
    <main className="flex min-h-dvh flex-col bg-background px-4 pt-8 pb-10">
      <div className="mx-auto grid w-full max-w-[960px] gap-6">
        <header className="grid gap-1">
          <p className="text-h3 text-foreground">Sample dispatch system</p>
          <p className="text-body text-foreground-2">
            {"Not a real product: it stands in for the carrier's TMS. LedgerLine reads it through its read-only " +
              "dispatch connection; nothing here is sent to anyone."}
          </p>
          <Link href="/" className="text-body text-foreground underline">
            Back to LedgerLine
          </Link>
        </header>
        {children}
      </div>
    </main>
  );
}
