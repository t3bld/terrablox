import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// There is one .env in this repo and it sits at the root: docker compose reads it
// natively, and the Prisma CLI finds it because `pnpm db:*` run from the root.
// Next is the odd one out — it only looks in the app directory — so it gets
// pointed at the root file here instead of keeping a second copy next door.
//
// process.loadEnvFile never overwrites a variable that is already set, so the
// precedence is the one you want: real environment first (docker run -e,
// `VAR=x pnpm dev`), the file only filling in the gaps. In the Docker image no
// root .env exists at all and every value arrives from the container environment.
const appDir = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(appDir, "../../.env");

if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

// Next loads apps/dashboard/.env by itself, before this file is evaluated, and
// those values then win over the root file. A copy left behind from before the
// consolidation would therefore silently shadow the root .env, which reads like
// the root file being ignored. Say so out loud instead.
if (existsSync(resolve(appDir, ".env"))) {
  console.warn(
    "\n[terrablox] apps/dashboard/.env exists and takes precedence over the root .env." +
      "\n[terrablox] Configuration lives in ./.env now — move anything you still need there and delete it.\n",
  );
}

/**
 * Content-Security-Policy.
 *
 * `'unsafe-inline'` for styles is unavoidable here: Tailwind is fine, but Next
 * injects inline `<style>` for critical CSS and the graph canvas sets inline
 * styles per node, and a nonce cannot reach those.
 *
 * `'unsafe-eval'` is dev-only — the webpack dev runtime needs it. Production gets
 * neither it nor inline script, which is what makes this policy worth having:
 * `script-src 'self'` is the line that stops an injected `<script>` from running.
 *
 * `img-src` has to be wide. README images point at arbitrary hosts by design, so
 * `https:` is the honest value; `data:` is there for the same reason. Widening
 * images is a privacy cost (the viewer's IP reaches whatever host a README names),
 * not a script-execution one.
 *
 * `connect-src` covers the app's own API only. The agent talks to GitHub and MCP
 * servers from the server, never from the browser.
 *
 * `frame-ancestors 'none'` is the real clickjacking control; `X-Frame-Options`
 * below is the same statement for anything that predates CSP2.
 */
function contentSecurityPolicy() {
  const dev = process.env.NODE_ENV !== "production";

  return [
    "default-src 'self'",
    `script-src 'self'${dev ? " 'unsafe-eval' 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // No plugins, no Flash, no <object>.
    "object-src 'none'",
    // Nothing may frame us, and we frame nothing.
    "frame-src 'none'",
    "frame-ancestors 'none'",
    // Stops a <base> tag from repointing every relative URL in the document.
    "base-uri 'self'",
    // Forms may only post back to us — an injected form cannot exfiltrate.
    "form-action 'self'",
    // Web workers and any nested browsing context stay same-origin.
    "worker-src 'self' blob:",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/**
 * Headers applied to every response.
 *
 * HSTS is emitted unconditionally, including in development. On localhost that is
 * inert — browsers do not apply HSTS to `localhost` — and emitting it from one
 * place beats deriving it from an env var that is wrong in exactly the deployment
 * where it matters. `preload` is deliberately absent: it is a one-way door owned
 * by whoever runs the instance, not by this file.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy() },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  // Redundant next to `frame-ancestors`, kept for older browsers.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Full URL to our own origin, bare origin to third parties. `no-referrer`
  // would break nothing here but also protects nothing extra.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app uses none of these, so none are granted.
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "display-capture=()",
      "encrypted-media=()",
      "fullscreen=(self)",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "usb=()",
      "xr-spatial-tracking=()",
    ].join(", "),
  },
  // Isolates this origin's browsing-context group from popups it opens.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Cross-origin reads of our documents need to opt in, which they cannot.
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `X-Powered-By: Next.js` on every response tells an attacker which
  // framework's advisories to read. Nothing needs it.
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Everything, API routes included: a JSON 401 benefits from `nosniff` and
        // from not being framable just as much as a page does.
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  // `next dev` and `next build` both own `.next`, and running them together makes
  // each rewrite the other's manifests — the build then fails with
  // "Cannot find module for page" for every route, including ones nobody touched,
  // which looks like broken code rather than two processes colliding. Setting
  // NEXT_DIST_DIR gives a build its own directory so it can be checked without
  // stopping the dev server. Unset, nothing changes.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  transpilePackages: [
    "@terrablox/ui",
    "@terrablox/auth",
    "@terrablox/database",
    "@terrablox/graph",
  ],
  experimental: {
    optimizePackageImports: ["@terrablox/ui"],
    // hcl2json resolves its WASM payload relative to __dirname, which webpack
    // would rewrite. Keep it external so the file stays reachable at runtime.
    // The Copilot SDK spawns a CLI binary from disk, so it must stay a real
    // module rather than a bundled one.
    //
    // `@prisma/client` is here for exactly the first reason. It locates its query
    // engine — a platform-specific `.node` binary — by searching relative to its own
    // `__dirname`, and webpack rewrites that to a path inside the bundle. The engine
    // is not there, so the first database query of the process fails with
    //
    //   Prisma Client could not locate the Query Engine for runtime "darwin-arm64"
    //
    // listing search paths that do not include where the engine actually is. It
    // surfaces as a 500 on anything that touches the database — most confusingly on
    // sign-in, which reads as "authentication failed" when nothing about auth is
    // wrong. Keeping it external means its `__dirname` is real and the engine sitting
    // next to it is found.
    serverComponentsExternalPackages: [
      "@cdktf/hcl2json",
      "@github/copilot-sdk",
      "@prisma/client",
    ],
  },
};

export default nextConfig;
