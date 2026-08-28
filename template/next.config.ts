import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Command Center builds in a staging copy, swaps the finished .next into
  // place and restarts the app, so nothing here needs to know about deploys.
  // Put whatever this particular site needs below.
  reactStrictMode: true,
};

export default nextConfig;
