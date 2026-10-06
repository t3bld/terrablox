import { describe, expect, it } from "vitest";

import { safeNextPath } from "./auth-routing";

describe("safeNextPath", () => {
  const home = "/projects";

  it("keeps an internal path", () => {
    expect(safeNextPath("/projects/abc", home)).toBe("/projects/abc");
    expect(safeNextPath("/modules?tab=readme", home)).toBe(
      "/modules?tab=readme",
    );
  });

  it("falls back when there is nothing to go to", () => {
    expect(safeNextPath(null, home)).toBe(home);
    expect(safeNextPath("", home)).toBe(home);
  });

  /**
   * The payload that actually worked.
   *
   * The login page builds `${window.location.origin}${next}`, so `@evil.com` yields
   * `https://app.example.com@evil.com` — userinfo plus a different host. It is the
   * dangerous one precisely because the real hostname is visible in the link.
   */
  it("rejects the userinfo trick", () => {
    expect(safeNextPath("@evil.com", home)).toBe(home);
    expect(safeNextPath("@evil.com/path", home)).toBe(home);
  });

  it("rejects protocol-relative and absolute targets", () => {
    expect(safeNextPath("//evil.com", home)).toBe(home);
    expect(safeNextPath("https://evil.com", home)).toBe(home);
    expect(safeNextPath("http://evil.com", home)).toBe(home);
    expect(safeNextPath("javascript:alert(1)", home)).toBe(home);
  });

  it("rejects backslashes, which browsers normalise to slashes", () => {
    expect(safeNextPath("/\\evil.com", home)).toBe(home);
    expect(safeNextPath("\\\\evil.com", home)).toBe(home);
  });

  it("rejects control characters", () => {
    expect(safeNextPath("/projects\nSet-Cookie: x=1", home)).toBe(home);
    expect(safeNextPath("\t@evil.com", home)).toBe(home);
  });
});
