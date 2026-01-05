/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@terrablox/ui",
    "@terrablox/auth",
    "@terrablox/database",
  ],
  experimental: {
    optimizePackageImports: ["@terrablox/ui"],
  },
};

module.exports = nextConfig;

