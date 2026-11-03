import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The local and CI database driver. Left to Node, never bundled; production uses the Data API.
  // The portal runner's browser driver is loaded on demand and left to Node too, as is the PDF
  // library the driver's paperwork renders with (its standard fonts are files it reads itself).
  serverExternalPackages: ["pg", "playwright-core", "pdfkit"],
  // Version stamp for the deploy check at /api/health. Amplify sets AWS_COMMIT_ID at build time.
  env: {
    APP_COMMIT: process.env.AWS_COMMIT_ID ?? "local",
  },
};

export default nextConfig;
