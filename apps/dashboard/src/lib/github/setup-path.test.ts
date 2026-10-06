import { describe, expect, it } from "vitest";

import {
  GITHUB_APP_SETUP_PATH,
  GITHUB_OAUTH_CALLBACK_PATH,
  isMisroutedInstallation,
} from "./setup-path";

/**
 * Which requests get taken away from Better Auth before it sees them.
 *
 * That is what this predicate decides, so both directions are worth pinning. Too loose
 * and a sign-in in progress gets diverted, which would break logging in for everyone.
 * Too strict and the bug it exists for comes back: a GitHub App installation landing on
 * the OAuth callback, where Better Auth finds no `state` it issued and answers
 * `error=state_not_found` to somebody who just granted repository access.
 */

function check(
  query: string,
  method = "GET",
  pathname = GITHUB_OAUTH_CALLBACK_PATH,
) {
  return isMisroutedInstallation({
    method,
    pathname,
    params: new URLSearchParams(query),
  });
}

describe("isMisroutedInstallation", () => {
  it("catches an installation that landed on the OAuth callback", () => {
    // What GitHub sends with "Request user authorization (OAuth) during installation"
    // still enabled: a code, an installation id, and no state — because GitHub started
    // this flow, not us.
    expect(check("code=abc&installation_id=987&setup_action=install")).toBe(
      true,
    );
  });

  it("catches a request awaiting an organisation owner", () => {
    // The case with no installation_id at all: a member without admin rights asked an
    // owner to approve, and this redirect is the only feedback the flow has.
    expect(check("setup_action=request")).toBe(true);
  });

  it("catches an installation id on its own", () => {
    expect(check("installation_id=987")).toBe(true);
  });

  it("leaves a real sign-in alone", () => {
    // Better Auth issues a state for every flow it starts, so this is a sign-in in
    // progress and diverting it would break logging in.
    expect(check("code=abc&state=s1")).toBe(false);
  });

  it("lets the state win over installation parameters", () => {
    // The decisive rule: if Better Auth started it, Better Auth owns the callback,
    // whatever else GitHub appended to the query.
    expect(check("code=abc&state=s1&installation_id=987")).toBe(false);
    expect(check("state=s1&setup_action=install")).toBe(false);
  });

  it("leaves a stateless callback with no installation parameters alone", () => {
    // Genuinely a broken OAuth callback. Better Auth's own `state_not_found` is the
    // right answer, and inventing a different one here would hide it.
    expect(check("")).toBe(false);
    expect(check("code=abc")).toBe(false);
  });

  it("ignores anything that is not a GET on that exact path", () => {
    expect(check("installation_id=987", "POST")).toBe(false);
    expect(
      check("installation_id=987", "GET", "/api/auth/callback/gitlab"),
    ).toBe(false);
    expect(
      check("installation_id=987", "GET", "/api/auth/sign-in/social"),
    ).toBe(false);
  });

  it("accepts a lower-case method, since callers differ", () => {
    expect(check("installation_id=987", "get")).toBe(true);
  });

  it("keeps the setup path off the auth prefix", () => {
    // Everything under `/api/auth/**` belongs to Better Auth. Forwarding an
    // installation to another path below it would land on the same state check.
    expect(GITHUB_APP_SETUP_PATH.startsWith("/api/auth/")).toBe(false);
  });
});
