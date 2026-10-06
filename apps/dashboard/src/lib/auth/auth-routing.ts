/**
 * Builds the `next` query parameter used for post-login redirects.
 */
export function buildNextParam(pathname: string, search: string) {
  const next = `${pathname}${search}`;
  return next && next !== "/" ? next : null;
}

/**
 * Where a post-login redirect is allowed to go.
 *
 * The login page reads `next` from the query string and appends it to
 * `window.location.origin`, which is exactly the shape that turns an unvalidated
 * value into an open redirect. The dangerous case is not the obvious one: an absolute
 * `https://evil.com` produces `https://app.example.comhttps://evil.com` and simply
 * fails, and `//evil.com` stays on our host as a path. What works is
 * `next=@evil.com`, because `https://app.example.com@evil.com` parses as userinfo
 * plus a *different* host — and it is a convincing phishing link precisely because
 * the real hostname is visible in it.
 *
 * So this is an allowlist, not a blocklist: one leading slash, not two, and nothing
 * that could be read as a scheme, an authority or a control character. Everything
 * that is not recognisably an internal path falls back to the home page, silently —
 * a rejected `next` is either an attack or a stale link, and neither deserves an
 * error message.
 *
 * Backslashes are refused because browsers normalise `\` to `/` in URLs, so `/\evil.com`
 * is another way of writing `//evil.com`.
 */
export function safeNextPath(value: string | null, fallback: string): string {
  if (!value) return fallback;

  // Must be a rooted path, and `//` would be a protocol-relative URL.
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (value.includes("\\")) return fallback;

  // A colon before the first slash would be a scheme; after a leading `/` there is
  // no such position, but an encoded newline or tab could still split a header in a
  // context that reflects this value.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\x00-\x1f\x7f]/.test(value)) return fallback;

  return value;
}

export type AuthRoutingConfig = {
  /** Auth pages reachable without a session. */
  publicPaths: string[];
  /**
   * The main protected home route.
   */
  homePath: string;
  /**
   * The login page route.
   */
  loginPath: string;
  /**
   * Returns true if a path should be protected.
   */
  isProtectedPath: (pathname: string) => boolean;
};

/**
 * Reachable without a session.
 *
 * Just the one page now: signing in is GitHub only, so there is no account to
 * create here and no password to reset.
 */
const UNAUTHENTICATED_PATHS = ["/login"];

export const defaultAuthRouting: AuthRoutingConfig = {
  publicPaths: ["/login"],
  homePath: "/projects",
  loginPath: "/login",
  // Everything else needs a session. Stated as an exception list because the
  // allowlist it replaces silently skipped every page nobody remembered to add.
  isProtectedPath: (pathname) => !UNAUTHENTICATED_PATHS.includes(pathname),
};
