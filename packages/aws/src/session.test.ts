import { describe, expect, it } from "vitest";

import { GITHUB_OIDC_PROVIDER, githubOidcProviderArn } from "./github-oidc";
import { type ProjectAwsSession, toClientCredentials } from "./session";

/**
 * The two small things the whole package is built on.
 *
 * `toClientCredentials` is three lines and worth a test for one reason: it is the seam
 * where an expiry must *not* travel. Everything downstream of it is an AWS SDK client, and
 * handing the SDK an `expiration` it did not ask for is the kind of thing that works until
 * a minor version tightens its input validation.
 */

const session: ProjectAwsSession = {
  credentials: {
    accessKeyId: "ASIA…",
    secretAccessKey: "secret",
    sessionToken: "token",
    expiration: new Date("2026-09-01T12:00:00.000Z"),
  },
  region: "eu-central-1",
  accountId: "545283928770",
  connectionLabel: "production",
};

describe("toClientCredentials", () => {
  it("hands the SDK exactly the three fields it wants", () => {
    expect(toClientCredentials(session)).toEqual({
      accessKeyId: "ASIA…",
      secretAccessKey: "secret",
      sessionToken: "token",
    });
  });

  it("leaves the expiry behind", () => {
    // Not a tidy-up: the expiry is ours to enforce before the call, not the client's to
    // interpret during it.
    expect(toClientCredentials(session)).not.toHaveProperty("expiration");
  });

  it("carries nothing about which connection produced the session", () => {
    // `connectionLabel` exists for error messages. A credential object that also named
    // the connection would put a user-facing label into every SDK request.
    const keys = Object.keys(toClientCredentials(session));
    expect(keys).not.toContain("connectionLabel");
    expect(keys).not.toContain("region");
  });
});

describe("githubOidcProviderArn", () => {
  it("names the one provider an account may have for GitHub", () => {
    expect(githubOidcProviderArn("545283928770")).toBe(
      `arn:aws:iam::545283928770:oidc-provider/${GITHUB_OIDC_PROVIDER}`,
    );
  });

  it("honours a partition, because GovCloud and China are their own AWS", () => {
    expect(githubOidcProviderArn("1", "aws-us-gov")).toContain(
      "arn:aws-us-gov:iam::1:",
    );
  });

  it("matches the issuer AWS actually federates to", () => {
    // A typo here is a trust policy that no workflow can ever satisfy, and the failure
    // arrives as `Not authorized to perform sts:AssumeRoleWithWebIdentity` — which points
    // at the role rather than at the name.
    expect(GITHUB_OIDC_PROVIDER).toBe("token.actions.githubusercontent.com");
  });
});
