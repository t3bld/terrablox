/**
 * The marketing site, built as plain files.
 *
 * `export` rather than a server, because there is nothing here for a server to do:
 * no route handlers, no middleware and no data fetching. That is what makes GitHub
 * Pages a sufficient host — and it is a property worth keeping, since the first
 * `fetch` in a page would still build and simply stop being static.
 *
 * One client component, the demo console, which an export ships as ordinary
 * JavaScript. Everything else renders to HTML at build time.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  /**
   * Where the site is served from, when that is not the domain root.
   *
   * A project page lives at `https://<user>.github.io/<repo>/`, and every absolute
   * asset path Next writes would then miss by that prefix — the page loads and the
   * CSS does not. A user, organisation or custom-domain site is served at the root
   * and needs this empty, which is the default. The CI workflow sets it.
   */
  basePath: process.env.PAGES_BASE_PATH ?? "",
  /**
   * Directory-style URLs: `/pricing` becomes `pricing/index.html`.
   *
   * Static hosts resolve a path to a file, and without this the export writes
   * `pricing.html`, which that path does not find. Harmless with one page and wrong
   * the moment there are two.
   */
  trailingSlash: true,
  images: {
    // There is no optimiser behind a static host, so the build refuses `next/image`
    // unless it is told to emit the sources untouched. Set now rather than
    // discovered later: nothing here uses `next/image` yet, and the failure would
    // land in CI on whoever adds the first one.
    unoptimized: true,
  },
  // Same escape hatch as the dashboard: `next dev` and `next build` both own
  // `.next`, so running them together makes each rewrite the other's manifests.
  // Unset, nothing changes.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // These ship TypeScript source rather than a build step, so Next has to compile
  // them as if they were app code.
  transpilePackages: [
    "@terrablox/ui",
    "@terrablox/graph",
    "@terrablox/terraform",
  ],
  experimental: {
    optimizePackageImports: ["@terrablox/ui"],
  },
};

export default nextConfig;
