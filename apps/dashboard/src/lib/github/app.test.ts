import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pending-installation-request flag.
 *
 * Worth testing because it is the only piece of GitHub state this app has to remember
 * for itself, and the reason it has to is not obvious: a request awaiting an
 * organisation owner is *not* an installation, so it appears in no endpoint reachable
 * with a user token, and the one that does list requests needs the app's private key —
 * which a self-hosted instance does not hold.
 *
 * The behaviour that matters is the self-healing clear. GitHub never tells us the
 * outcome of a request, so nothing can observe "approved" or "rejected"; the flag has
 * to resolve on the only signal that does arrive, which is an installation existing.
 * Get that wrong in the strict direction and the notice never goes away; get it wrong
 * in the loose direction and it never shows.
 */

const findUnique = vi.fn();
const update = vi.fn();

vi.mock("@/lib/database", () => ({
  database: { user: { findUnique, update } },
}));

const { githubInstallRequest, githubAppInstallUrl, githubAppSetupUrl } =
  await import("./app");

describe("githubInstallRequest", () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
  });

  it("returns null when nothing was ever requested", async () => {
    findUnique.mockResolvedValue({ githubInstallRequestedAt: null });

    expect(await githubInstallRequest("u1", false)).toBeNull();
    // Nothing to clear, so nothing is written on a read path.
    expect(update).not.toHaveBeenCalled();
  });

  it("reports the request while no installation exists", async () => {
    const at = new Date("2026-09-03T10:00:00.000Z");
    findUnique.mockResolvedValue({ githubInstallRequestedAt: at });

    // The pending case: this is what stops every picker from saying "not installed
    // yet" and sending the person back to file a second request.
    expect(await githubInstallRequest("u1", false)).toBe(at.toISOString());
    expect(update).not.toHaveBeenCalled();
  });

  it("clears the request once any installation is present", async () => {
    findUnique.mockResolvedValue({
      githubInstallRequestedAt: new Date("2026-09-03T10:00:00.000Z"),
    });
    update.mockResolvedValue({});

    // Approval, a rejection worked around by installing on a personal account, and an
    // abandoned request all end here: an installation exists, so the question is
    // settled and the notice has to stop.
    expect(await githubInstallRequest("u1", true)).toBeNull();
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { githubInstallRequestedAt: null },
    });
  });

  it("does not write when there is nothing to clear", async () => {
    findUnique.mockResolvedValue({ githubInstallRequestedAt: null });

    // The common path — installed, never requested — must not turn a read into a
    // write on every page load.
    expect(await githubInstallRequest("u1", true)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("treats a missing user as nothing requested", async () => {
    findUnique.mockResolvedValue(null);

    expect(await githubInstallRequest("gone", false)).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("the two GitHub App URLs", () => {
  it("keeps the setup path off the auth prefix", () => {
    // Everything under `/api/auth/**` belongs to Better Auth and validates a `state`
    // it issued. The installation flow has none, which is the whole bug this path
    // exists to avoid.
    expect(githubAppSetupUrl()).toContain("/api/github/installations/callback");
    expect(githubAppSetupUrl()).not.toContain("/api/auth/");
  });

  it("points the install link at the configured app", () => {
    expect(githubAppInstallUrl()).toMatch(
      /^https:\/\/github\.com\/apps\/[^/]+\/installations\/new$/,
    );
  });
});
