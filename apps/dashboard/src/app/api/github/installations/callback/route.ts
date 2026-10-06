import { NextResponse } from "next/server";

import { audit } from "@/lib/audit/log";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";

/**
 * Where GitHub sends somebody who has just installed, changed or requested the app.
 *
 * This route exists because the installation flow is *not* an OAuth flow, and it was
 * being handled as one. A GitHub App has two return URLs and they do different jobs:
 *
 *   Callback URL  the OAuth redirect. Better Auth owns it, it initiates every
 *                 sign-in, and it validates the `state` it issued.
 *   Setup URL     where GitHub returns after an install, a permission change, or a
 *                 request to an organisation owner. GitHub initiates this one.
 *
 * With no Setup URL configured, GitHub falls back to the Callback URL — so an
 * installation landed on Better Auth's OAuth callback carrying an `installation_id`
 * and no `state`. Better Auth looked the state up, found nothing, and redirected to
 * `/api/auth/error?error=state_not_found`, which is a correct answer to the question
 * it was asked and a confusing dead end for the person who just granted access.
 *
 * So this is the Setup URL. It is deliberately outside `/api/auth/**`.
 *
 * Nothing is persisted. `listUserInstallations` reads the installations back through
 * the user's own token whenever the account screen asks, so the `installation_id`
 * GitHub passes here is not a fact this app needs to store — and storing it would
 * create a second source of truth that a revoked install would silently contradict.
 */

/** Where the user ends up, whatever happened. */
const LANDING = "/account";

/**
 * What GitHub says it did, normalised to something the UI can phrase.
 *
 * `setup_action` is GitHub's own vocabulary. `request` is the one that matters here
 * and the one that has no `installation_id`: a member without admin rights on an
 * organisation cannot install the app, so GitHub records a request for an owner to
 * approve and sends them back with nothing installed yet. Treating that as a failure
 * — or as a success — would both be wrong, so it gets its own outcome.
 */
function outcomeOf(setupAction: string | null): string {
  switch (setupAction) {
    case "install":
      return "installed";
    case "update":
      return "updated";
    case "request":
      return "requested";
    default:
      // GitHub also returns here when somebody backs out of the install page, with
      // no `setup_action` at all. Nothing happened, and saying so is the honest
      // outcome; the account screen re-reads the installations either way.
      return "unchanged";
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const setupAction = url.searchParams.get("setup_action");
  const installationId = url.searchParams.get("installation_id");

  const outcome = outcomeOf(setupAction);

  // Signed in or not, the destination is the same: the account page is behind the
  // middleware, so an expired session lands on the login page with `next` pointing
  // back here rather than on an error. There is nothing to authorise in this
  // request — it carries no credential and grants nothing, it only reports what
  // GitHub already did on GitHub's side.
  const userId = await getCurrentUserId();

  if (userId) {
    // Worth a row: this is the moment the installation's repository grant changed,
    // which is the boundary of everything the app can subsequently read or commit.
    // The id is recorded even though it is not stored on the user, so a later
    // "why could it suddenly see that repository" has a timestamp to start from.
    await audit({
      action: "github.installation.returned",
      userId,
      subject: installationId,
      detail: { setupAction, outcome },
    });

    /**
     * The one thing worth remembering, because GitHub will not tell us again.
     *
     * A pending request is invisible: it is not an installation, so no endpoint
     * reachable with a user token reports it, and the endpoint that does list requests
     * needs the app's private key. This redirect is therefore the only moment the app
     * ever learns that a request exists — hence writing it down rather than deriving it
     * later.
     *
     * Set on `request`, cleared on anything that means the question is settled. A
     * second request overwrites the first, which is the right answer for somebody who
     * asked a different organisation.
     */
    if (outcome === "requested") {
      await database.user.update({
        where: { id: userId },
        data: { githubInstallRequestedAt: new Date() },
      });
    } else if (outcome === "installed" || outcome === "updated") {
      await database.user.update({
        where: { id: userId },
        data: { githubInstallRequestedAt: null },
      });
    }
  }

  // Built from the configured origin, not from `url.origin`.
  //
  // `request.url` is derived from the Host header, which the client supplies — so
  // taking the origin from it would let a forged Host decide where this redirect
  // sends somebody. The path is fixed, so the worst case is landing on
  // `evil.example/account`, but a redirect whose destination is attacker-influenced
  // is worth not writing in the first place. The request origin stays as the fallback
  // for a developer who has set no origin at all, where it is the only answer
  // available and the Host is their own.
  const configuredOrigin =
    process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL;

  const origin = (() => {
    if (!configuredOrigin) return url.origin;
    try {
      return new URL(configuredOrigin).origin;
    } catch {
      return url.origin;
    }
  })();

  const destination = new URL(LANDING, origin);
  destination.searchParams.set("github", outcome);

  // 303 rather than 307: the browser arrived here by following GitHub's redirect of
  // a GET, and 303 is the status that says "go look at this other thing instead"
  // without inviting the method to be replayed.
  return NextResponse.redirect(destination, 303);
}
