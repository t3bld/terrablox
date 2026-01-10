import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createSupabaseServerAuth } from "@terrablox/auth/adapters/supabase";

// This file can be removed, but is kept for demonstration purposes.
// It defines the routing configuration for the middleware.
import {
  buildNextParam,
  defaultAuthRouting,
  type AuthRoutingConfig,
} from "@/lib/auth/auth-routing";

function isPublicAuthPath(pathname: string, cfg: AuthRoutingConfig) {
  return cfg.publicPaths.includes(pathname);
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const cfg = defaultAuthRouting;

  // Always prepare a response so auth providers can attach refreshed cookies.
  const res = NextResponse.next();

  // In a real application, you might use a factory pattern to switch between
  // different auth providers. For this example, we'll directly use the
  // Supabase implementation.
  const auth = createSupabaseServerAuth();
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
