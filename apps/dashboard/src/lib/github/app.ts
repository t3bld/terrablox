import "server-only";

/**
 * Which GitHub App this instance is, for the one thing the browser needs to know:
 * where to send somebody who has not installed it yet.
 *
 * Configurable rather than hardcoded because every self-hosted instance registers
 * its own app. A shared app would mean every Terrablox deployment on earth
 * authenticating through one client secret held by us, which is the opposite of
 * what "no required managed services" promises.
 *
 * The default matches the app published at github.com/apps/terrablox, so an
 * instance that only ever signs in against that one needs no extra configuration.
 */
import { database } from "@/lib/database";
import { GITHUB_APP_SETUP_PATH as SETUP_PATH } from "@/lib/github/setup-path";

const DEFAULT_APP_SLUG = "terrablox";

/**
 * `||` rather than `??`: a line left as `GITHUB_APP_SLUG=` in .env is an
 * unconfigured value, not a configured empty one, and with `??` it would win over
 * the default and produce `github.com/apps//installations/new`.
 */
export const githubAppSlug = process.env.GITHUB_APP_SLUG || DEFAULT_APP_SLUG;

/**
 * Where a user goes to grant Terrablox access to repositories.
 *
 * GitHub picks the account and repository selection on this page, so there is
 * nothing to pass and nothing to pre-fill. It is also the page to return to for
 * *changing* a selection later, which is why the UI labels it by what it achieves
 * rather than by "install".
 *
 * Deliberately not a `NEXT_PUBLIC_` variable. Those are inlined at build time, and
 * baking an app slug into the bundle would make one image valid for one
 * registration — the same reasoning that keeps NEXT_PUBLIC_APP_URL out of the
 * Dockerfile. It reaches the browser through the API responses that need it.
 */
export function githubAppInstallUrl(): string {
  return `https://github.com/apps/${githubAppSlug}/installations/new`;
}

// Re-exported so existing importers keep one place to ask, while the constant itself
// lives in a module the Edge middleware can also import — this one cannot be, it
// reaches the database.
export { GITHUB_APP_SETUP_PATH } from "@/lib/github/setup-path";

/**
 * The absolute Setup URL for this instance, for the settings screen to show.
 *
 * Built from the same origin the auth config uses, so an instance that has
 * `BETTER_AUTH_URL` right cannot be told to configure a Setup URL that is wrong. The
 * fallback matches the dev server rather than being an error: on a developer's
 * machine that *is* the answer.
 */
export function githubAppSetupUrl(): string {
  const origin =
    process.env.BETTER_AUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3001";

  return new URL(SETUP_PATH, origin).toString();
}

/**
 * Whether this user is waiting on an organisation owner, as an ISO timestamp or null.
 *
 * Self-healing, and that is the whole design: `installed` says whether GitHub reports
 * any installation right now, and any installation at all settles the question. So an
 * approval, a rejection the person worked around by installing on their own account,
 * and a request they simply abandoned all resolve without anything having to observe
 * the *outcome* — which is convenient, because GitHub reports none of them.
 *
 * The clear is a write on a read path, which is worth being deliberate about: it fires
 * only in the one transition (a stored request, and an installation now exists), so it
 * is not a write per page load.
 */
export async function githubInstallRequest(
  userId: string,
  installed: boolean,
): Promise<string | null> {
  const user = await database.user.findUnique({
    where: { id: userId },
    select: { githubInstallRequestedAt: true },
  });

  const requestedAt = user?.githubInstallRequestedAt ?? null;
  if (!requestedAt) return null;

  if (installed) {
    await database.user.update({
      where: { id: userId },
      data: { githubInstallRequestedAt: null },
    });
    return null;
  }

  return requestedAt.toISOString();
}
