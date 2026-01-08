import type { NextRequest, NextResponse } from "next/server";

/**
 * Server-side auth contract used by middleware.
 *
 * Why this exists:
 * - Middleware runs on the server/edge and can only see cookies/headers.
 * - We want the dashboard to be open-source friendly and not hard depend on a specific auth provider.
 *
 * Implementations should:
 * - Determine whether the incoming request is authenticated (usually via cookies).
 * - Optionally refresh/rotate cookies on the outgoing response.
 */
export interface ServerAuth {
  /**
   * Returns true if the request represents an authenticated user.
   *
   * Implementations MUST NOT throw for anonymous visitors.
   */
  isAuthenticated: (req: NextRequest, res: NextResponse) => Promise<boolean>;
}

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

export const defaultAuthRouting: AuthRoutingConfig = {
  publicPaths: ["/login", "/signup", "/forgot-password"],
  homePath: "/projects",
  loginPath: "/login",
  isProtectedPath: (pathname) =>
    pathname === "/" ||
    pathname.startsWith("/projects") ||
    pathname.startsWith("/modules") ||
    pathname.startsWith("/account"),
};

