/**
 * Builds the `next` query parameter used for post-login redirects.
 */
export function buildNextParam(pathname: string, search: string) {
  const next = `${pathname}${search}`;
  return next && next !== "/" ? next : null;
}

export type AuthRoutingConfig = {
  /**
   * Public auth pages (login/signup/forgot-password).
   */
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
 * Reachable without a session. `/reset-password` is opened from an email link,
 * so it has to work for someone who by definition cannot sign in.
 */
const UNAUTHENTICATED_PATHS = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
];

export const defaultAuthRouting: AuthRoutingConfig = {
  publicPaths: ["/login", "/signup", "/forgot-password"],
  homePath: "/projects",
  loginPath: "/login",
  // Everything else needs a session. Stated as an exception list because the
  // allowlist it replaces silently skipped every page nobody remembered to add.
  isProtectedPath: (pathname) => !UNAUTHENTICATED_PATHS.includes(pathname),
};
