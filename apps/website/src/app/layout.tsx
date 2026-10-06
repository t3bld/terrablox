import type { Metadata } from "next";
import { Inter } from "next/font/google";

import "../styles/globals.css";
// React Flow's own stylesheet, which the architecture diagram in the demo needs.
// Imported here rather than in the component so its order against the Tailwind
// layers is fixed, which is how the dashboard does it too.
import "@terrablox/graph/styles.css";

// The same font the dashboard loads, for the same reason the tokens are shared:
// the site and the product should not look like two different pieces of software.
const inter = Inter({ subsets: ["latin"] });

/**
 * One description, used everywhere.
 *
 * It says what the reader gets rather than what category the product is in, and it
 * is the same sentence in the tab title, the search result and the link preview —
 * three places that used to be able to drift apart.
 */
const DESCRIPTION =
  "Terrablox designs AWS infrastructure and commits it as real Terraform to your own repository, then deploys it through GitHub Actions with no stored credentials. Open source and self-hosted.";

/**
 * The address this site is canonically served from, in one place.
 *
 * `www`, not the apex, and that is not a preference — it has to match the custom
 * domain configured under Settings → Pages, because that is the host GitHub answers
 * on and issues the certificate for. The other one redirects to it, so both work in a
 * browser; what does not tolerate the mismatch is metadata. `metadataBase` resolves
 * canonical and Open Graph URLs, so pointing it at the apex while the site is served
 * from `www` publishes a canonical URL that redirects — which is a crawler following a
 * hop to find the page it is already on, and two hostnames competing for the same
 * content.
 *
 * If the custom domain in the repository settings is ever changed to the apex, change
 * this with it. Those two values are one decision in two places.
 */
const SITE_URL = "https://www.terrablox.de";

const TITLE = "Terrablox — AWS infrastructure as Terraform you own";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "Terrablox",
    type: "website",
  },
};

/**
 * Content-Security-Policy as a meta tag, because this site has no server.
 *
 * A static export on GitHub Pages cannot send response headers, so `headers()` in
 * next.config.mjs would be silently ignored — `<meta http-equiv>` is the only
 * mechanism a static host leaves. It covers less than the real header does:
 * `frame-ancestors` and HSTS are both ignored in meta form, so framing and
 * transport are the host's business here (GitHub Pages sends HSTS itself).
 *
 * `script-src` allows inline, and that is not laziness. The App Router ships the
 * component payload as inline `<script>self.__next_f.push(...)</script>` — twenty-odd
 * of them on the landing page — and React has nothing to hydrate with if they are
 * blocked. The strict alternative is a per-response nonce, which needs a server to
 * generate one, which is the thing a static export does not have. This directive read
 * `'self'` until the demo became interactive, and the result was a page whose only
 * client component silently never started: every button rendered and none of them
 * did anything.
 *
 * The exposure is narrower than the directive looks. Nothing here is user-generated
 * or fetched at runtime: every byte of markup is compiled at build time from files in
 * this repository, so there is no path by which an attacker's string reaches the
 * document in the first place. Worth revisiting the day this site renders anything it
 * did not build itself.
 *
 * `unsafe-eval` in development only: Next compiles dev bundles with an eval-based
 * devtool and webpack executes each module through it, so without this nothing runs
 * locally while production stays free of it.
 *
 * `unsafe-inline` for styles is next/font and Next's critical CSS.
 */
const CSP = [
  "default-src 'self'",
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta content={CSP} httpEquiv="Content-Security-Policy" />
        <meta content="nosniff" httpEquiv="X-Content-Type-Options" />
        <meta content="strict-origin-when-cross-origin" name="referrer" />
      </head>
      <body className={inter.className}>{children}</body>
    </html>
  );
}
