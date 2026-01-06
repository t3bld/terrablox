/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@terrablox/auth", "@terrablox/database"],
};

export default nextConfig;
