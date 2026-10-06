import "server-only";

import { ApiError } from "@/lib/api/route-error";

/**
 * Cross-site request forgery, for the routes Better Auth does not cover.
 *
 * `/api/auth/*` has its own origin check. The other fifty-odd route handlers had
 * none, and what protected them was the session cookie's `sameSite: "lax"`: a
 * browser will not attach it to a cross-site POST. That is a genuine defence, but it
 * was the *only* one, and it was inherited from a library default rather than chosen
 * — flipping the cookie to `sameSite: "none"` for an embedded client would have
 * silently opened every state-changing route, including the ones that start a
 * deployment.
 *
 * So this is the second layer, and it is deliberately not a token. A synchroniser
 * token needs a place to live, a rotation story and a hook in every form; an origin
 * check needs neither and rejects the same attack, because the one thing a
 * cross-site attacker cannot do is forge `Origin` or `Sec-Fetch-Site` from a
 * browser. Both are set by the browser itself and unreachable from page script.
 */

/**
 * Verbs that change something.
 *
 * `GET` and `HEAD` are excluded because they must be safe by definition — any GET
 * route that mutates is a bug this check should not paper over.
 */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The origins a state-changing request may come from.
 *
 * The same value the auth config trusts, resolved the same way, so the two cannot
 * drift apart. An empty `BETTER_AUTH_URL` falls through to the app URL and then to
 * localhost, which is what a development setup wants.
 */
function trustedOrigin(): string {
  return (
    process.env.BETTER_AUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3001"
  );
}

function normaliseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Rejects a state-changing request that did not originate from this app.
 *
 * The check, in order of preference:
 *
 *   1. `Sec-Fetch-Site`. Set by every current browser and impossible to override
 *      from script. `same-origin` and `none` (a direct navigation or a non-browser
 *      client) pass; `cross-site` is refused outright.
 *   2. `Origin`. Present on every cross-origin request and on all same-origin
 *      requests with a body. Compared by origin, not by string, so a trailing slash
 *      or a default port cannot cause a false rejection.
 *
 * A request with neither header is allowed. That is not an oversight: `curl`, the
 * GitHub Actions runner and any server-to-server client send neither, and refusing
 * them would break legitimate non-browser use to defend against an attack that is
 * browser-only by construction. The threat model here is "a page on evil.com makes
 * the victim's browser act", and such a page cannot suppress both headers.
 *
 * `Referer` is deliberately not consulted. It is stripped by privacy settings and by
 * `Referrer-Policy`, so treating its absence as suspicious would produce false
 * rejections for exactly the users who configured their browser most carefully.
 */
export function assertSameOrigin(request: Request): void {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return;

  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") {
    // `same-site` is refused as well: a sibling subdomain is a different trust
    // boundary, and nothing in this app is served from one.
    throw new ApiError("Cross-site requests are not allowed.", 403);
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    // No Origin and no cross-site signal. Either a same-origin request from a
    // browser that omitted it, or a non-browser client. Neither is the attack.
    return;
  }

  const expected = normaliseOrigin(trustedOrigin());
  const actual = normaliseOrigin(origin);

  // An unparseable expectation means the instance is misconfigured. Failing open
  // here would make a bad BETTER_AUTH_URL disable the check silently, so it fails
  // closed and says which value is wrong.
  if (!expected) {
    throw new ApiError(
      "This instance has no valid configured origin, so writes are refused.",
      500,
    );
  }

  if (actual !== expected) {
    throw new ApiError("Cross-site requests are not allowed.", 403);
  }
}
