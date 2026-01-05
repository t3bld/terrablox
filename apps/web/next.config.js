/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@terrablox/ui"],
  experimental: {
    optimizePackageImports: ["@terrablox/ui"],
  },
};

module.exports = nextConfig;

