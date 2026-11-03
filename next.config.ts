import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The MCP endpoint and health check are the only routes; there is no UI.
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
