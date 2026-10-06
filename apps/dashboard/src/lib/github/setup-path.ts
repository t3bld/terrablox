/**
 * Where GitHub returns after an install, a permission change, or a request.
 *
 * Its own module, with no imports, because three places need it and they cannot all
 * reach the same code: the route handler that serves it, `lib/github/app.ts` (which
 * imports the database and is therefore server-only), and `middleware.ts` (which runs
 * on the Edge runtime and can import neither). A duplicated string literal across
 * those three would be a silent divergence the first time it moved.
 *
 * It is also the value that has to be typed into the GitHub App's settings, under
 * **Setup URL**.
 *
 * Deliberately not under `/api/auth/**`: everything below that prefix belongs to Better
 * Auth, which validates a `state` it issued. The installation flow is started by GitHub
 * and has no state, which is the whole reason this path exists.
 */
export const GITHUB_APP_SETUP_PATH = "/api/github/installations/callback";

/**
 * Better Auth's OAuth callback for GitHub.
 *
 * Named here so the middleware can recognise an installation that landed on it. Not
 * configurable — it is where the auth library listens.
 */
export const GITHUB_OAUTH_CALLBACK_PATH = "/api/auth/callback/github";

/**
 * Whether this request is a GitHub App installation that arrived at the OAuth callback.
 *
 * A pure predicate rather than a condition inside the middleware, because of what it
 * decides: which requests are taken away from Better Auth before it sees them. That is
 * worth being able to state and prove, not bury in a redirect.
 *
 * The discriminator is exact, not a guess. Better Auth issues a `state` for every
 * sign-in it starts and its callback refuses one without it, so a `state`-less callback
 * cannot be a sign-in in progress. Add `installation_id` or `setup_action` — which only
 * GitHub's installation redirect carries — and there is exactly one thing it can be.
 *
 * The `state` check comes first and is decisive: if Better Auth started the flow, it
 * owns the callback, whatever else is in the query. That is what makes a real sign-in
 * untouchable here even when GitHub appends an `installation_id` to it.
 */
export function isMisroutedInstallation(input: {
  method: string;
  pathname: string;
  params: URLSearchParams;
}): boolean {
  if (input.method.toUpperCase() !== "GET") return false;
  if (input.pathname !== GITHUB_OAUTH_CALLBACK_PATH) return false;

  // Better Auth started this one. Hands off.
  if (input.params.get("state")) return false;

  return (
    input.params.has("installation_id") || input.params.has("setup_action")
  );
}
