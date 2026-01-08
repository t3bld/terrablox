import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  buildNextParam,
  defaultAuthRouting,
  type AuthRoutingConfig,
} from "@/lib/auth/server-auth";
import { getServerAuth } from "@/lib/auth/server-auth-factory";

function isPublicAuthPath(pathname: string, cfg: AuthRoutingConfig) {
  return cfg.publicPaths.includes(pathname);
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const cfg = defaultAuthRouting;

  // Always prepare a response so auth providers can attach refreshed cookies.
  const res = NextResponse.next();

  const auth = getServerAuth();
  const isAuthed = await auth.isAuthenticated(req, res);

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

  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|assets|robots.txt|sitemap.xml).*)",
  ],
};
