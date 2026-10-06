import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  type AuthRoutingConfig,
  buildNextParam,
  defaultAuthRouting,
} from "@/lib/auth/auth-routing";
import {
  GITHUB_APP_SETUP_PATH,
  isMisroutedInstallation,
} from "@/lib/github/setup-path";

function isPublicAuthPath(pathname: string, cfg: AuthRoutingConfig) {
  return cfg.publicPaths.includes(pathname);
}

/** Verbs that change something and therefore need an origin check. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The origin this instance is served from.
 *
 * Resolved exactly like `baseURL` in `lib/auth/server.ts` and `trustedOrigin()` in
 * `lib/api/csrf.ts`, so the three cannot disagree about what "us" means.
 */
function trustedOrigin(): string {
  return (
    process.env.BETTER_AUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3001"
  );
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Cross-site request forgery, enforced for every API route in one place.
 *
 * This lives in middleware rather than in the handlers on purpose. There are fifty-odd
 * route files, none of them had a CSRF check, and the only thing standing between a
 * page on another origin and a started deployment was the session cookie's
 * `sameSite: "lax"` — a real defence, but a single inherited default. Adding a call to
 * every handler would have worked until the fifty-first handler forgot it; a matcher
 * cannot forget.
 *
 * Not a token, deliberately. A synchroniser token needs storage, rotation and a hook
 * in every form. `Origin` and `Sec-Fetch-Site` are set by the browser and unreachable
 * from page script, which is the one property the attack cannot work around.
 *
 * Requests carrying neither header pass. That is not a hole: `curl` and any
 * server-to-server client send neither, refusing them would break legitimate
 * non-browser use, and a hostile *page* cannot suppress both.
 */
function csrfRejection(req: NextRequest): NextResponse | null {
  if (!UNSAFE_METHODS.has(req.method.toUpperCase())) return null;

  const deny = () =>
    NextResponse.json(
      { error: "Cross-site requests are not allowed." },
      { status: 403 },
    );

  // `same-site` is refused alongside `cross-site`: a sibling subdomain is a
  // different trust boundary, and nothing here is served from one.
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return deny();

  const origin = req.headers.get("origin");
  if (!origin) return null;

  const expected = originOf(trustedOrigin());

  // A misconfigured origin fails closed. Failing open would let a bad
  // BETTER_AUTH_URL disable this check without anyone noticing.
  if (!expected) {
    return NextResponse.json(
      { error: "This instance has no valid configured origin." },
      { status: 500 },
    );
  }

  return originOf(origin) === expected ? null : deny();
}

/**
 * Catches a GitHub App installation that landed on the OAuth callback.
 *
 * A GitHub App has two return URLs. The **Callback URL** is the OAuth redirect, which
 * Better Auth owns and which validates a `state` it issued when it started the sign-in.
 * The **Setup URL** is where GitHub returns after an install, a permission change, or a
 * request to an organisation owner — GitHub starts those, so there is no state.
 *
 * Two settings send an installation to the wrong one: leaving the Setup URL empty, or
 * leaving *Request user authorization (OAuth) during installation* enabled. Either way
 * the installation arrives at Better Auth's callback with an `installation_id` and no
 * `state`, Better Auth looks the state up, finds nothing, and answers
 * `error=state_not_found`. Correct, and a dead end for whoever just granted access —
 * most visibly when installing on an organisation, where the redirect is the only
 * feedback the flow has.
 *
 * Documenting the settings was not enough: an app that only works when an operator
 * ticks the right obscure checkbox is an app that will be misconfigured. So the
 * misrouted case is recognised and forwarded to the route that can actually handle it.
 *
 * The discriminator is exact rather than heuristic. Better Auth generates a `state` for
 * every sign-in it starts and its callback throws without one, so a `state`-less
 * callback cannot be a legitimate sign-in; combined with `installation_id` or
 * `setup_action` it can only be GitHub's installation redirect. A real sign-in always
 * carries a state and is therefore untouchable by this.
 */
function misroutedInstallation(req: NextRequest): NextResponse | null {
  const misrouted = isMisroutedInstallation({
    method: req.method,
    pathname: req.nextUrl.pathname,
    params: req.nextUrl.searchParams,
  });

  if (!misrouted) return null;

  const destination = req.nextUrl.clone();
  destination.pathname = GITHUB_APP_SETUP_PATH;

  // The OAuth code is dropped rather than forwarded. With OAuth-during-installation
  // enabled GitHub sends one, and it is a credential: nothing downstream needs it —
  // whoever is installing is already signed in — so it should not travel on into a URL
  // that lands in browser history and in the next request's referrer.
  destination.searchParams.delete("code");

  return NextResponse.redirect(destination, 303);
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // API routes get the origin check and nothing else. Authentication for them is
  // the handlers' own job — see the note below on why the cookie check here is not
  // authorization — so there is no redirect to apply.
  if (pathname.startsWith("/api/")) {
    return (
      misroutedInstallation(req) ?? csrfRejection(req) ?? NextResponse.next()
    );
  }

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
    // `api` is included now — it used to be excluded, which is why none of the API
    // routes had a CSRF check. Static assets stay out: they are GET-only, so the
    // origin check would never fire, and running middleware on them costs latency
    // on every image.
    "/((?!_next/static|_next/image|favicon.ico|assets|robots.txt|sitemap.xml).*)",
  ],
};
