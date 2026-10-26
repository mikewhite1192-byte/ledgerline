import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Payday Copilot",
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
