import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The local and CI database driver. Left to Node, never bundled; production uses the Data API.
  serverExternalPackages: ["pg"],
  // Version stamp for the deploy check at /api/health. Amplify sets AWS_COMMIT_ID at build time.
  env: {
    APP_COMMIT: process.env.AWS_COMMIT_ID ?? "local",
  },
};

export default nextConfig;
