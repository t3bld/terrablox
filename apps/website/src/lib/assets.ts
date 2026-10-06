/**
 * A path to a file in `public/`, prefixed the way the deployment serves it.
 *
 * `next/link` and `next/image` apply `basePath` themselves; a plain `<img src>` does
 * not. So a project page served from `https://<user>.github.io/<repo>/` would load
 * every module icon from the domain root and get a 404 — one of those failures that
 * only appears in the deployment nobody tests locally.
 *
 * Read from the same variable `next.config.mjs` passes to `basePath`, so the two
 * cannot disagree. Empty for a custom domain, which is the normal case.
 */
export function asset(pathname: string): string {
  const base = process.env.PAGES_BASE_PATH ?? "";
  return `${base}${pathname}`;
}
