import type { Metadata } from "next";
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
