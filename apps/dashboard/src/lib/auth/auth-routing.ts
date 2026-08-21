/**
 * Builds the `next` query parameter used for post-login redirects.
 */
export function buildNextParam(pathname: string, search: string) {
  const next = `${pathname}${search}`;
  return next && next !== "/" ? next : null;
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
