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
  webpack: (config) => {
    // Monaco's editorWorkerService contains
    // `new URL('../../common/services/editorWebWorkerMain.js', import.meta.url)`.
    // Webpack turns that into an asset and copies the file verbatim, so the
    // minifier then chokes on ESM syntax in what it treats as a classic script.
    // `@terrablox/code-viewer` supplies the worker via MonacoEnvironment, so
    // this reference is dead at runtime and safe to leave unprocessed.
    config.module.rules.push({
      test: /editorWorkerService\.js$/,
      include: /monaco-editor/,
      parser: { url: false },
    });

    return config;
  },
};

export default nextConfig;
