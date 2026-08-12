import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  type AuthRoutingConfig,
  buildNextParam,
  defaultAuthRouting,
} from "@/lib/auth/auth-routing";

function isPublicAuthPath(pathname: string, cfg: AuthRoutingConfig) {
  return cfg.publicPaths.includes(pathname);
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const cfg = defaultAuthRouting;

  // Next.js 14 middleware runs on the Edge runtime, which cannot reach the
  // database. We only check for the presence of the session cookie here to
  // redirect optimistically - this is NOT an authorization check. Route
  // handlers and pages must validate the session with `auth.api.getSession`.
  const isAuthed = !!getSessionCookie(req);

  if (!isAuthed && cfg.isProtectedPath(pathname)) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = cfg.loginPath;

    const next = buildNextParam(pathname, search);
    if (next) {
      redirectUrl.searchParams.set("next", next);
    }

    return NextResponse.redirect(redirectUrl);
  }

  if (isAuthed && isPublicAuthPath(pathname, cfg)) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = cfg.homePath;
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|assets|robots.txt|sitemap.xml).*)",
  ],
};
