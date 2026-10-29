import "server-only";

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import type { GithubProfile } from "better-auth/social-providers";

import { database } from "@/lib/database";

const githubClientId = process.env.GITHUB_CLIENT_ID;
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;

export const isGithubConfigured = !!githubClientId && !!githubClientSecret;

// `||` rather than `??`: an env var that is present but empty - a line left as
// `BETTER_AUTH_URL=` in .env, or the empty NEXT_PUBLIC_APP_URL build arg the
// Dockerfile defaults to - is an unconfigured value, not a configured empty one.
// With `??` it would win over the fallback and break every OAuth callback.
const baseURL =
  process.env.BETTER_AUTH_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "http://localhost:3001";

/**
 * The signing secret, or a refusal to start.
 *
 * Better Auth does not require this. Left unset it falls back to a constant
 * shipped in the package — `better-auth-secret-1234567890...` — and only logs a
 * warning, so the app would boot, sign sessions with a value anyone can read off
 * npm, and look completely healthy. Session cookies would be forgeable by anybody.
 *
 * It is worse than that here, because this secret is not only a signing key:
 * `secret-box` HKDFs it into the AES-256-GCM key for stored AWS SSO tokens and MCP
 * auth headers, and `encryptOAuthTokens` below has Better Auth derive the key for
 * GitHub tokens from it too. Those tokens carry `repo` and `workflow`. A default
 * secret therefore means every credential in the database is decryptable with
 * public knowledge.
 *
 * So this throws at module load. `secret-box` already fails the same way, but
 * lazily — on the first encrypt — which meant sign-in kept working on the default
 * key while only the AWS features broke. A missing secret has to stop the process,
 * not degrade one feature.
 *
 * The 32-character floor is not cryptographic precision, it is a typo filter:
 * anything shorter than the 32-byte output of `openssl rand -base64 24` is
 * someone's placeholder rather than a generated value.
 */
function requireAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();

  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Sessions cannot be signed and stored " +
        "credentials cannot be encrypted. Generate one with `openssl rand -base64 32`.",
    );
  }

  if (secret.length < 32) {
    throw new Error(
      `BETTER_AUTH_SECRET is ${secret.length} characters, which is too short to be ` +
        "a generated secret. Use `openssl rand -base64 32`.",
    );
  }

  return secret;
}

/**
 * Whether cookies get the `Secure` attribute.
 *
 * Derived from the configured origin rather than from `NODE_ENV`, because those two
 * disagree in exactly the deployment that matters: a production image behind a
 * TLS-terminating proxy has `NODE_ENV=production` but talks plain HTTP internally,
 * and a `BETTER_AUTH_URL` left as `http://…` there would otherwise hand out session
 * cookies without `Secure` — readable by anyone on the path to the proxy.
 *
 * Stated explicitly instead of inherited so it is visible in review, and so the
 * boot check below can complain about the http-in-production case rather than
 * silently doing the weaker thing.
 */
const useSecureCookies = baseURL.startsWith("https://");

if (
  process.env.NODE_ENV === "production" &&
  !useSecureCookies &&
  // A local production build is a normal thing to run; only warn about a real host.
  !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$|\/)/.test(baseURL)
) {
  console.warn(
    `[terrablox] BETTER_AUTH_URL is ${baseURL} in production. Session cookies will ` +
      "be sent without the Secure attribute and OAuth callbacks will use http. " +
      "Set it to the https origin users actually reach.",
  );
}

export const auth = betterAuth({
  appName: "Terrablox",
  baseURL,
  secret: requireAuthSecret(),
  database: prismaAdapter(database, { provider: "postgresql" }),

  /**
   * Which origins may drive the auth endpoints and be redirected to.
   *
   * Unset, this defaults to `baseURL` — which is correct, but only as long as
   * `baseURL` is. Since `baseURL` falls back to `http://localhost:3001`, a
   * deployment that forgot `BETTER_AUTH_URL` would trust localhost and nothing
   * else, and the failure would read as broken OAuth rather than as a missing
   * variable. Naming it here makes the trust boundary explicit, and it is what
   * rejects a `callbackURL` pointing anywhere off this origin.
   */
  trustedOrigins: [baseURL],

  session: {
    // Seven days, which is Better Auth's own default, restated so it is a decision
    // rather than an inheritance.
    expiresIn: 60 * 60 * 24 * 7,
    // Sliding window: a session in daily use is refreshed rather than expiring
    // mid-task, while an abandoned one still ages out on the seven-day clock.
    updateAge: 60 * 60 * 24,
    // Re-authentication window for sensitive operations. Better Auth's default is
    // a day; an hour is closer to what "fresh" should mean for an app that can
    // reach a customer's AWS account.
    freshAge: 60 * 60,
  },

  /**
   * Rate limits on the auth endpoints.
   *
   * Only `enabled` is set, and deliberately: the numbers are Better Auth's and they
   * are better than the ones that were here.
   *
   * What was here was `window: 60, max: 30` applied globally, which looked cautious
   * and was two mistakes. The key is per IP *and per path*, so that budget applied
   * separately to every endpoint — including `/get-session`, which the client calls on
   * every render and navigation. Thirty in a minute is nothing for a read the app makes
   * constantly, so signing in locally failed with "Too many requests" once the page had
   * been open for a moment. The library's default is 100 per 10 seconds, which is
   * twenty times more generous and still a limit.
   *
   * It also did not make sign-in safer, which was the point. Better Auth already ships
   * stricter rules for exactly the paths worth protecting — `/sign-in*`, `/sign-up*`,
   * `/change-password`, `/change-email` get 3 per 10 seconds, and the password-reset
   * and verification-email paths get 3 per 60 — and those override the global value
   * either way. Raising the global number could only ever loosen them.
   *
   * `enabled` is stated rather than inherited because it is the one decision worth
   * making here, and the previous version got it wrong in the other direction: forcing
   * it on in development is friction with no benefit — the attacker this defends
   * against is not on localhost — while leaving it off in production would be a real
   * gap. This is the library's own default, written down.
   *
   * Storage is in-memory, so it is per process and resets on restart. That is a real
   * limitation, and the reason the app-level limiter in `lib/api/rate-limit` exists for
   * everything outside `/api/auth/**`.
   */
  rateLimit: {
    enabled: process.env.NODE_ENV === "production",
  },

  // No email and password. Every feature needs a GitHub identity — reading a
  // project's repository, committing the graph, importing modules, running the
  // agent on the user's Copilot seat — so an account without one could sign in
  // and then do nothing. Turning it off here and not only in the UI matters: the
  // endpoints stay reachable otherwise, and a sign-up route nobody links to is
  // still a sign-up route.
  emailAndPassword: { enabled: false },

  // Terrablox authenticates as a **GitHub App**, not an OAuth App, and the
  // difference decides what this block can and cannot say.
  //
  // There is deliberately no `scope` here. GitHub Apps do not use scopes: what the
  // resulting user token may do is fixed by the app's registered permissions and
  // narrowed to the repositories each installation was granted. A `scope` array
  // would be sent and silently ignored, which is worse than absent — it would read
  // like the access control it is not.
  //
  // The permissions the app must be registered with, and why each one:
  //
  //   Repository → Metadata: Read          `GET /repos/{repo}`, branches
  //   Repository → Contents: Read+Write    read trees, files, commits, tags and
  //                                        releases; commit the graph
  //   Repository → Workflows: Read+Write   commits that touch `.github/workflows/`
  //                                        are refused without it, on top of
  //                                        Contents, because a workflow file can
  //                                        read the repository's secrets
  //   Repository → Actions: Read+Write     list workflow runs, dispatch a run
  //   Repository → Variables: Read+Write   the deployment pipeline's configuration
  //
  // Nothing else, and in particular none of these, which earlier versions asked for:
  //
  //   Administration   creating a project's repository. Projects now bind a
  //                    repository that already exists (lib/projects/bind-repo.ts),
  //                    so the app never creates, deletes or reconfigures one.
  //   Secrets          never used: the pipeline's configuration is repository
  //                    *Variables*, because none of it is secret (lib/projects/deploy.ts).
  //   Email addresses  see `mapProfileToUser` below.
  //
  // Installing on "Only select repositories" is supported and recommended: a project
  // can only be bound to a repository that is in the selection.
  //
  // The token this yields is a `ghu_` user-to-server token. That is also what the
  // Copilot SDK is handed for the agent (see lib/agent/copilot.ts); GitHub lists
  // `ghu_` as supported there, and the entitlement comes from the user's own
  // Copilot subscription rather than from any permission above.
  socialProviders: isGithubConfigured
    ? {
        github: {
          clientId: githubClientId as string,
          clientSecret: githubClientSecret as string,
          /**
           * An email for accounts that do not publish one.
           *
           * The app no longer has the *Email addresses* permission, so the
           * provider's fallback to `/user/emails` is answered with a 403. That does
           * not throw — the provider reads the result as "no emails" — but a profile
           * without a public email then reaches the callback with none at all, and
           * Better Auth refuses the sign-in with `email_not_found`.
           *
           * GitHub's own noreply address fills the gap: `{id}+{login}@…` is the form
           * GitHub itself uses for commits, and the numeric id makes it unique per
           * account even after a rename. Nothing here sends mail — there is no SMTP —
           * and the address is only displayed, so a placeholder costs nothing.
           *
           * Returned only when GitHub gave no email, and an empty object otherwise,
           * because the provider spreads this *after* its own `email`: anything
           * returned here wins. Existing users are unaffected either way — sign-in
           * finds them by provider and account id, not by email.
           */
          mapProfileToUser: (profile: GithubProfile) =>
            profile.email
              ? {}
              : {
                  email: `${profile.id}+${profile.login}@users.noreply.github.com`,
                },
        },
      }
    : undefined,

  account: {
    // GitHub tokens are long-lived, so encrypt them at rest.
    encryptOAuthTokens: true,

    accountLinking: {
      // GitHub verifies the emails it hands out, so we accept it as proof of
      // identity when attaching a GitHub login to an existing account.
      trustedProviders: ["github"],
      // Nothing verifies email here — there is no SMTP server, and no local
      // password to attach one to. Left at its default this would block linking
      // for accounts created before sign-in became GitHub only.
      requireLocalEmailVerified: false,
      // A work login address and a personal GitHub address are rarely the same.
      // Only applies to explicit linking by an already signed-in user, never to
      // sign-in, which still matches strictly on email.
      allowDifferentEmails: true,
    },
  },

  advanced: {
    database: {
      // Keeps ids UUIDs so they line up with the @db.Uuid columns
      // already used by projects, modules and canvas nodes.
      generateId: "uuid",
    },

    // See the comment on the constant: derived from the origin, not from NODE_ENV.
    useSecureCookies,

    /**
     * Cookie attributes, pinned rather than inherited.
     *
     * `sameSite: "lax"` is the only CSRF defence the custom API routes have — they
     * carry no token, and `lib/api/csrf` checks `Origin` as the second layer. It is
     * Better Auth's default, but a default is not a decision: setting
     * `sameSite: "none"` for an embedded client would silently expose every
     * state-changing route in the app, and a reviewer should have to delete this
     * comment to do it.
     *
     * `lax` rather than `strict` because `strict` breaks the OAuth return: GitHub
     * redirects the browser to us cross-site, and a strict cookie would not be sent
     * on that navigation, so the callback would land unauthenticated.
     */
    cookies: {
      session_token: {
        attributes: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
        },
      },
    },
  },

  // Must stay last so Set-Cookie headers from server actions are applied.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
