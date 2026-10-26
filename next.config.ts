import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Version stamp for the deploy check at /api/health. Amplify sets AWS_COMMIT_ID at build time.
  env: {
    APP_COMMIT: process.env.AWS_COMMIT_ID ?? "local",
  },
};

export default nextConfig;
