import type { Metadata } from "next";
import Script from "next/script";
import { ToastProvider } from "@/components/app/toast";
import { sans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "LedgerLine",
  description: "An AI operator for a trucking carrier's money desk.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // theme.js sets data-theme before first paint, so React must not warn that it differs.
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <body>
        <Script src="/theme.js" strategy="beforeInteractive" />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
