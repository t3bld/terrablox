import { describe, expect, it } from "vitest";

import {
  assertPublicUrl,
  parseIpv4,
  parseIpv6,
  UnsafeUrlError,
} from "./public-url";

/**
 * These cases are the bypasses the previous hostname-prefix check let through.
 *
 * Kept as tests rather than as a comment because every one of them is a way for a URL
 * that *looks* external to resolve to something inside the network the agent runs in,
 * and the next person to touch this file needs the list to still be enforced.
 */

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof UnsafeUrlError) return error.reason;
    throw error;
  }
  return "accepted";
}

describe("parseIpv4", () => {
  it("reads dotted decimal", () => {
    expect(parseIpv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("8.8.8.8")).toEqual([8, 8, 8, 8]);
  });

  it("reads the collapsed and numeric forms a resolver accepts", () => {
    // All of these are 127.0.0.1, and none of them start with "127.".
    expect(parseIpv4("2130706433")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0x7f000001")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("127.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0177.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("0x7f.0.0.1")).toEqual([127, 0, 0, 1]);
  });

  it("rejects what is not an address at all", () => {
    expect(parseIpv4("example.com")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("256.0.0.1")).toBeNull();
    expect(parseIpv4("")).toBeNull();
  });
});

describe("parseIpv6", () => {
  it("expands the compressed form", () => {
    expect(parseIpv6("::1")?.slice(14)).toEqual([0, 1]);
    expect(parseIpv6("fd00::1")?.slice(0, 2)).toEqual([0xfd, 0x00]);
  });

  it("reads a bracketed literal and an IPv4-mapped address", () => {
    expect(parseIpv6("[::1]")).not.toBeNull();
    expect(parseIpv6("::ffff:127.0.0.1")?.slice(12)).toEqual([127, 0, 0, 1]);
  });

  it("returns null for a hostname", () => {
    expect(parseIpv6("example.com")).toBeNull();
  });
});

describe("assertPublicUrl", () => {
  it("accepts an ordinary https endpoint", () => {
    expect(assertPublicUrl("https://mcp.example.com/sse")).toBe(
      "https://mcp.example.com/sse",
    );
  });

  it("requires https", () => {
    expect(reason(() => assertPublicUrl("http://mcp.example.com"))).toBe(
      "scheme",
    );
  });

  it("refuses credentials in the URL", () => {
    // `https://real-host@internal/` is read by some clients as a request to
    // `internal`, so the userinfo form is refused outright.
    expect(
      reason(() => assertPublicUrl("https://user:pw@mcp.example.com")),
    ).toBe("credentials");
  });

  it("blocks loopback in every encoding", () => {
    for (const host of [
      "127.0.0.1",
      "127.1",
      "2130706433",
      "0x7f000001",
      "0177.0.0.1",
      "[::1]",
      "[::ffff:127.0.0.1]",
    ]) {
      expect(
        reason(() => assertPublicUrl(`https://${host}/`)),
        host,
      ).toBe("private-address");
    }
  });

  it("blocks the private and metadata ranges", () => {
    for (const host of [
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254", // EC2/Azure instance metadata
      "100.64.0.1", // CGNAT, used by EKS and Fargate
      "0.0.0.0",
      "[fd00::1]", // unique local
      "[fe80::1]", // link local
    ]) {
      expect(
        reason(() => assertPublicUrl(`https://${host}/`)),
        host,
      ).toBe("private-address");
    }
  });

  it("allows a public address that merely looks close to a private one", () => {
    // 172.32 is outside RFC1918, and 100.128 is outside the CGNAT block. A range
    // check that is off by one octet would reject these.
    expect(assertPublicUrl("https://172.32.0.1/")).toContain("172.32.0.1");
    expect(assertPublicUrl("https://100.128.0.1/")).toContain("100.128.0.1");
    expect(assertPublicUrl("https://11.0.0.1/")).toContain("11.0.0.1");
  });

  it("blocks names that only resolve inside a cluster", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "metadata.google.internal",
      "thing.internal",
      "printer.local",
      "api.cluster.local",
      "vault.svc",
    ]) {
      expect(
        reason(() => assertPublicUrl(`https://${host}/`)),
        host,
      ).toBe("private-address");
    }
  });

  it("blocks a single-label hostname", () => {
    // `https://vault` resolves through a search domain, so on a public network it
    // cannot be what the user meant.
    expect(reason(() => assertPublicUrl("https://vault/"))).toBe(
      "single-label",
    );
    expect(reason(() => assertPublicUrl("https://kube-apiserver/"))).toBe(
      "single-label",
    );
  });

  it("rejects a string that is not a URL", () => {
    expect(reason(() => assertPublicUrl("not a url"))).toBe("invalid");
  });
});
