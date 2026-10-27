import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { flags } from "@/config/flags";

// The fictional broker portal the runner reads (design 3.1). It is deliberately plain and looks
// like a different site: no app navigation, no LedgerLine colors, no login of ours. Every page
// carries the same footer saying the company and its data are made up.

const PORTAL_NAME = "Fernhill Freight Exchange";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: PORTAL_NAME,
  robots: { index: false, follow: false },
};

export default function PortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (!flags.portalRunnerEnabled) notFound();
  return (
    <div className="min-h-screen bg-[#f2f1ec] text-[#111111]" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
      <header className="border-b-4 border-[#2f4f3a] bg-white px-6 py-4">
        <p className="text-2xl font-bold">{PORTAL_NAME}</p>
        <p className="text-base">Carrier portal</p>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-6 text-lg">{children}</main>
      <footer className="border-t border-[#999999] px-6 py-4 text-base">
        Fictional demo portal. Not a real company. All data is synthetic.
      </footer>
    </div>
  );
}
