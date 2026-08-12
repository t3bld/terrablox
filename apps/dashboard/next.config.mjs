/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@terrablox/ui",
    "@terrablox/auth",
    "@terrablox/database",
    "@terrablox/code-viewer",
    "@terrablox/graph",
  ],
  experimental: {
    optimizePackageImports: ["@terrablox/ui"],
    // hcl2json resolves its WASM payload relative to __dirname, which webpack
    // would rewrite. Keep it external so the file stays reachable at runtime.
    // The Copilot SDK spawns a CLI binary from disk, so it must stay a real
    // module rather than a bundled one.
    serverComponentsExternalPackages: [
      "@cdktf/hcl2json",
      "@github/copilot-sdk",
    ],
  },
};

export default nextConfig;
